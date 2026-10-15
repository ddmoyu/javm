import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanLog,
  logEvent,
  redactText,
  setLogSink,
} from "../frontend/src/services/logging/events";
import type { LogEntry, LogInput } from "../frontend/src/services/logging/events";
import { LogService } from "../frontend/src/services/logging/LogService";
import { logPolicy, RotatingLogStore } from "../frontend/src/services/logging/RotatingLogStore";
import type { LogFilePort } from "../frontend/src/services/logging/RotatingLogStore";
import { deferred } from "./helpers/deferred";
import { importDownloadLog } from "../frontend/src/services/logging/legacyDownloads";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";

const baseTime = Date.parse("2026-10-10T09:00:00Z");
const input = (message = "应用启动", level: LogInput["level"] = "info"): LogInput => ({
  level,
  module: "app",
  event: "test",
  message,
});
const entry = (sequence: number, message = "合成日志"): LogEntry => ({
  ...input(message),
  time: new Date(baseTime).toISOString(),
  session: "test-session",
  sequence,
});
function memory() {
  const files = new Map<string, string>();
  const port: LogFilePort = {
    directory: "memory/logs",
    list: vi.fn(async () =>
      [...files].map(([name, text]) => ({ name, size: Buffer.byteLength(text) })),
    ),
    append: vi.fn(async (name, content) => {
      files.set(name, (files.get(name) ?? "") + content);
    }),
    remove: vi.fn(async (name) => {
      files.delete(name);
    }),
    tail: vi.fn(async (name, bytes) => {
      const raw = Buffer.from(files.get(name) ?? "");
      return raw.subarray(Math.max(0, raw.length - bytes)).toString("utf8");
    }),
    openDirectory: vi.fn(async () => {}),
  };
  return { port, files };
}
afterEach(() => {
  setLogSink();
  vi.useRealTimers();
});

describe("统一日志的大小、保留期与并发写入", () => {
  it("采用 5 MiB × 10 个文件和 7 天的生产策略", () => {
    expect(logPolicy).toEqual({ fileBytes: 5242880, files: 10, days: 7 });
  });
  it("按 UTF-8 实际字节轮转，同时限制文件数量和总容量", async () => {
    const { port, files } = memory();
    const policy = { fileBytes: 900, files: 3, days: 7 };
    const store = new RotatingLogStore(port, policy, () => baseTime);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.append([entry(i, "中文😀".repeat(22))])),
    );
    expect(files.size).toBe(3);
    expect([...files.values()].every((text) => Buffer.byteLength(text) <= policy.fileBytes)).toBe(
      true,
    );
    expect(
      [...files.values()].reduce((total, text) => total + Buffer.byteLength(text), 0),
    ).toBeLessThanOrEqual(2700);
    expect((await store.recent())[0]?.sequence).toBe(9);
    for (const text of files.values())
      for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });
  it("批量追加减少原生调用，重启不会覆盖已有日志", async () => {
    const { port, files } = memory();
    await new RotatingLogStore(port).append([entry(1), entry(2), entry(3)]);
    expect(port.append).toHaveBeenCalledTimes(1);
    await new RotatingLogStore(port).append([entry(4)]);
    expect(files.size).toBe(2);
    expect(
      (await new RotatingLogStore(port).recent())
        .map((item) => item.sequence)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4]);
  });
  it("启动与持续运行均清理过期文件，只删除自己的日志", async () => {
    const { port, files } = memory();
    const expired = `javm-${baseTime - 8 * 86400000}-123456ab-1.jsonl`;
    files.set(expired, "old");
    files.set("notes.txt", "用户文件");
    files.set("javm-not-a-log.jsonl", "保留");
    let now = baseTime;
    const store = new RotatingLogStore(port, logPolicy, () => now);
    await store.maintain();
    expect(files.has(expired)).toBe(false);
    await store.append([entry(1)]);
    const current = [...files.keys()].find((name) => /^javm-\d/.test(name))!;
    now += 8 * 86400000;
    await store.maintain();
    expect(files.has(current)).toBe(false);
    expect(files.get("notes.txt")).toBe("用户文件");
    expect(files.get("javm-not-a-log.jsonl")).toBe("保留");
  });
  it("跨天主动换文件，近期读取有上限且忽略损坏末行", async () => {
    const { port, files } = memory();
    let now = baseTime;
    const store = new RotatingLogStore(port, logPolicy, () => now);
    await store.append(Array.from({ length: 250 }, (_, i) => entry(i)));
    now += 86400000;
    await store.append([entry(251)]);
    expect(files.size).toBe(2);
    const last = [...files.keys()].at(-1)!;
    files.set(last, files.get(last)! + '{"broken":');
    const recent = await store.recent();
    expect(recent).toHaveLength(200);
    expect(recent[0]?.sequence).toBe(251);
    expect(vi.mocked(port.tail).mock.calls.every((call) => call[1] === 65536)).toBe(true);
  });
  it("部分写入失败后换文件重试，近期视图按记录标识去重", async () => {
    const { port, files } = memory();
    const original = port.append;
    port.append = vi
      .fn()
      .mockImplementationOnce(async (name: string, content: string) => {
        files.set(name, content);
        throw new Error("磁盘中断");
      })
      .mockImplementation(original);
    const store = new RotatingLogStore(port);
    await expect(store.append([entry(1)])).rejects.toThrow();
    await store.append([entry(1), entry(2)]);
    expect(files.size).toBe(2);
    expect((await store.recent()).map((item) => item.sequence)).toEqual([2, 1]);
  });
});

describe("日志队列与脱敏", () => {
  it("近期旧下载日志脱敏后汇入，写入失败或取消时不允许删除旧副本", async () => {
    const task = createDownloadTasks(
      {
        urls: ["https://example.com/video?token=secret"],
        directory: "C:/test",
        kind: "auto",
        headers: { Cookie: "session=private" },
      },
      [],
    )[0]!;
    task.log = ["历史日志 session=private", task.url];
    const write = vi.fn();
    const flush = vi.fn(async () => {});
    setLogSink(write, flush, () => true);
    expect(await importDownloadLog(task)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/private|token=secret/);
    setLogSink(write, flush, () => false);
    expect(await importDownloadLog(task)).toBe(false);
    expect(await importDownloadLog(task, () => true)).toBe(false);
  });
  it("7 天前的旧下载日志直接过期，不重新延长保留期限", async () => {
    const task = createDownloadTasks(
      { urls: ["https://example.com/video"], directory: "C:/test", kind: "auto", headers: {} },
      [],
    )[0]!;
    task.updatedAt = new Date(Date.now() - 8 * 86400000).toISOString();
    task.log = ["过期日志"];
    const write = vi.fn();
    setLogSink(write);
    expect(await importDownloadLog(task)).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("统一隐藏链接、代理凭据、授权头与命名密钥，保留可用诊断", () => {
    const result = cleanLog({
      ...input(
        'failed https://alice:password@host/video?token=abc Bearer sk-very-secret api_key="another-secret"',
      ),
      context: { taskId: "123", token: "secret", headers: "Cookie: secret", count: 2 },
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/alice|password|host\/video|abc|sk-very-secret|another-secret|Cookie/);
    expect(result.context).toEqual({ taskId: "123", count: 2 });
    expect(redactText("\x1b[31m错误\x1b[0m\0")).toBe("错误");
    expect(redactText("123😀x", 4)).toBe("123…");
  });
  it("空队列刷新后仍能写入，所有模块共享一个流，debug 默认不落盘", async () => {
    const { port, files } = memory();
    const service = new LogService(new RotatingLogStore(port));
    await service.flush();
    setLogSink(service.record, service.flush);
    logEvent("info", "downloads", "started", "下载开始");
    logEvent("warn", "library", "partial", "扫描部分失败");
    logEvent("debug", "downloads", "progress", "30%");
    await service.shutdown();
    expect(files.size).toBe(1);
    expect((await service.recent()).map((item) => item.module)).toEqual(["library", "downloads"]);
  });
  it("慢磁盘下最多排队 500 条，错误优先，丢弃计数也会写入", async () => {
    const { port } = memory();
    const service = new LogService(new RotatingLogStore(port));
    const listener = vi.fn();
    service.subscribe(listener);
    for (let i = 0; i < 900; i++) service.record(input(`记录 ${i}`));
    service.record(input("关键错误", "error"));
    expect(listener).toHaveBeenCalledTimes(1);
    await service.shutdown();
    expect(service.getSnapshot().dropped).toBe(401);
    const recent = await service.recent();
    expect(recent.some((item) => item.message === "关键错误")).toBe(true);
    expect(recent.some((item) => item.event === "queue_overflow")).toBe(true);
    expect(port.append).toHaveBeenCalledTimes(33);
  });
  it("写入失败有可见错误，保留有界待写数据，恢复后可重试", async () => {
    const { port } = memory();
    const append = port.append;
    port.append = vi.fn().mockRejectedValueOnce(new Error("只读目录")).mockImplementation(append);
    const service = new LogService(new RotatingLogStore(port));
    service.record(input());
    await service.flush();
    expect(service.getSnapshot().error).toContain("写入失败");
    await service.flush();
    expect(service.getSnapshot().error).toBe("");
    expect(await service.recent()).toHaveLength(1);
    await service.shutdown();
  });
  it("退出等待正在写入的批次，并继续写入收尾期间的新记录", async () => {
    const { port } = memory();
    const pending = deferred<void>();
    const append = port.append;
    port.append = vi
      .fn()
      .mockImplementationOnce(async (name, content) => {
        await pending.promise;
        await append(name, content);
      })
      .mockImplementation(append);
    const service = new LogService(new RotatingLogStore(port));
    service.record(input("开始"));
    const flushing = service.flush();
    await Promise.resolve();
    service.record(input("退出收尾"));
    const stopped = service.shutdown();
    pending.resolve();
    await Promise.all([flushing, stopped]);
    expect((await service.recent()).map((item) => item.message)).toEqual(["退出收尾", "开始"]);
  });
  it("浏览器预览不制造持久化日志；日志接收器故障不传播到业务", async () => {
    const preview = new LogService();
    preview.record(input());
    expect(preview.getSnapshot().available).toBe(false);
    expect(await preview.recent()).toEqual([]);
    setLogSink(() => {
      throw new Error("日志不可用");
    });
    expect(() => logEvent("error", "app", "test", "测试")).not.toThrow();
  });
});
