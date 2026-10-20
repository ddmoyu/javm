import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FeedbackService } from "../frontend/src/services/feedback/FeedbackService";
import type {
  FeedbackPort,
  FeedbackState,
} from "../frontend/src/services/feedback/FeedbackService";
import {
  diagnosticText,
  failureFromLog,
  feedbackPolicy,
  issuesUrl,
} from "../frontend/src/services/feedback/report";
import { setFailureSink } from "../frontend/src/services/feedback/events";
import { reportDownloadFailure } from "../frontend/src/services/feedback/downloads";
import { LogService } from "../frontend/src/services/logging/LogService";
import { setLogSink } from "../frontend/src/services/logging/events";
import type { LogEntry, LogInput } from "../frontend/src/services/logging/events";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import type { DownloadEngine, DownloadRepository } from "../frontend/src/services/downloads/ports";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type { DownloadTask } from "../frontend/src/contracts/downloads";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";

const time = Date.parse("2026-10-15T06:00:00Z");
const link =
  "https://media.example.invalid/safe-demo.m3u8?token=fictional-token&signature=fictional-signature";
const failure = {
  module: "downloads",
  title: "检测到下载失败",
  message: "仍有 2 个 HLS 分片未能下载",
  taskId: "safe-task",
  url: link,
};
const created: FeedbackService[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
});
afterEach(() => {
  for (const service of created.splice(0)) service.dispose();
  setFailureSink();
  setLogSink();
  vi.useRealTimers();
});
function log(message: string, context?: LogInput["context"]): LogInput {
  return { level: "info", module: "downloads", event: "tool_output", message, context };
}
function setup(initial: unknown = null) {
  let saved: unknown = initial;
  const logs = new LogService();
  const port = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (state: FeedbackState) => {
      saved = structuredClone(state);
    }),
    system: vi.fn(async () => ({
      JAVM: "test-version",
      操作系统: "Safe Test OS",
      CPU: "Mock CPU",
      物理内存: "8 GiB",
    })),
    copy: vi.fn(async (_text: string) => {}),
    open: vi.fn(async (_url: string) => {}),
  } satisfies FeedbackPort;
  const service = new FeedbackService(logs, port);
  created.push(service);
  return { service, port, logs, saved: () => saved as FeedbackState };
}

describe("统一异常反馈", () => {
  it("隐藏含空格的用户名以及 JSON 转义后的用户目录", () => {
    const paths = [
      "C:\\Users\\Safe User\\cache",
      "/home/Safe User/cache",
      "/Users/Safe User/cache",
    ];
    for (const path of paths) {
      expect(diagnosticText(path)).not.toContain("Safe User");
      expect(diagnosticText(JSON.stringify({ path }))).not.toContain("Safe User");
    }
  });
  it("保留完整下载链接，普通日志与上下文隐藏凭据和用户名", async () => {
    const { service, logs, port } = setup();
    await service.initialize();
    logs.record(log("失败于 C:\\Users\\safe-user\\cache，token=secret-value"));
    const id = service.capture({
      ...failure,
      details: { path: "/home/safe-user/cache", password: "hidden-secret" },
    });
    await vi.advanceTimersByTimeAsync(3001);
    await service.submit(id);
    const copied = port.copy.mock.calls[0]![0];
    expect(copied).toContain(link);
    expect(copied).toContain("Safe Test OS");
    expect(copied).toContain("HLS 分片");
    expect(copied).not.toContain("safe-user");
    expect(copied).not.toContain("secret-value");
    expect(copied).not.toContain("hidden-secret");
  });
  it("立即固定故障前日志，收集后 3 秒日志并排除其他任务", async () => {
    const { service, logs } = setup();
    await service.initialize();
    logs.record(log("目标任务准备", { taskId: "safe-task" }));
    logs.record(log("另一个任务", { taskId: "other" }));
    const id = service.capture(failure);
    logs.record(log("目标任务收尾", { taskId: "safe-task" }));
    await vi.advanceTimersByTimeAsync(3001);
    for (let i = 0; i < 500; i++) logs.record(log(`后续无关记录 ${i}`));
    const text = service.preview(id);
    expect(text).toContain("目标任务准备");
    expect(text).toContain("目标任务收尾");
    expect(text).not.toContain("另一个任务");
    expect(text).not.toContain("后续无关记录");
    expect(logs.getRecentEntries()).toHaveLength(400);
  });
  it("同类异常合并，关闭后短期内不重复弹框", async () => {
    const { service } = setup();
    await service.initialize();
    const id = service.capture(failure);
    service.dismiss();
    service.capture(failure);
    expect(service.getSnapshot().reports).toHaveLength(1);
    expect(service.getSnapshot().reports[0]!.count).toBe(2);
    expect(service.getSnapshot().activeId).toBeUndefined();
    service.capture({ ...failure, taskId: "second", message: "另一个故障" });
    expect(service.getSnapshot().activeId).toBeUndefined();
    service.open(id);
    expect(service.getSnapshot().activeId).toBe(id);
  });
  it("大量故障有界且不会替换用户正在查看的报告", async () => {
    const { service } = setup();
    await service.initialize();
    const first = service.capture(failure);
    for (let i = 0; i < 30; i++) service.capture({ ...failure, taskId: `safe-${i}` });
    expect(service.getSnapshot().reports).toHaveLength(feedbackPolicy.reports);
    expect(service.getSnapshot().activeId).toBe(first);
    expect(service.preview(first)).toContain(link);
  });
  it("复制成功后才请求打开固定 Issue 地址，日志不放入 URL", async () => {
    const { service, port } = setup();
    await service.initialize();
    const order: string[] = [];
    port.copy.mockImplementation(async () => {
      order.push("copy");
    });
    port.open.mockImplementation(async () => {
      order.push("open");
    });
    const result = await service.submit(service.capture(failure));
    expect(order).toEqual(["copy", "open"]);
    expect(port.open).toHaveBeenCalledWith(issuesUrl);
    expect(result).toContain("粘贴提交即可");
  });
  it("复制失败时不打开浏览器，不显示成功", async () => {
    const { service, port } = setup();
    await service.initialize();
    port.copy.mockRejectedValue(new Error("模拟剪贴板占用"));
    await expect(service.submit(service.capture(failure))).rejects.toThrow("复制失败");
    expect(port.open).not.toHaveBeenCalled();
    expect(service.getSnapshot().busy).toBe(false);
  });
  it("浏览器打开失败时仍明确告知已复制，并支持仅复制", async () => {
    const { service, port } = setup();
    await service.initialize();
    port.open.mockRejectedValue(new Error("模拟浏览器缺失"));
    const id = service.capture(failure);
    expect(await service.submit(id)).toContain("浏览器未能打开");
    port.open.mockClear();
    await service.submit(id, false);
    expect(port.open).not.toHaveBeenCalled();
  });
  it("持久化后的报告和链接在下次正常启动仍可复制", async () => {
    const first = setup();
    await first.service.initialize();
    const id = first.service.capture(failure);
    await vi.advanceTimersByTimeAsync(3001);
    await first.service.prepareExit();
    const second = setup(first.saved());
    await second.service.initialize();
    expect(second.service.getSnapshot().reports).toHaveLength(1);
    expect(second.service.getSnapshot().activeId).toBeUndefined();
    await second.service.submit(id, false);
    expect(second.port.copy.mock.calls[0]![0]).toContain(link);
  });
  it("异常退出只读取上次会话日志，使用上次系统信息且不断言崩溃原因", async () => {
    const previous = setup();
    await previous.service.initialize();
    await vi.advanceTimersByTimeAsync(251);
    const next = setup(previous.saved());
    vi.spyOn(next.logs, "recent").mockResolvedValue([
      {
        ...log("上次会话证据"),
        session: previous.logs.getSession(),
        sequence: 1,
        time: new Date(time).toISOString(),
      },
      {
        ...log("无关会话记录"),
        session: "unrelated",
        sequence: 2,
        time: new Date(time).toISOString(),
      },
    ]);
    next.port.system.mockResolvedValue({
      JAVM: "new-version",
      操作系统: "Different OS",
      CPU: "Other",
      物理内存: "16 GiB",
    });
    await next.service.initialize();
    const report = next.service.getSnapshot().reports[0]!;
    expect(report.title).toBe("上次未正常退出");
    expect(report.message).toContain("强制结束或断电");
    expect(report.before).toContain("上次会话证据");
    expect(report.before).not.toContain("无关会话记录");
    expect(report.system.操作系统).toBe("Safe Test OS");
    expect(report.complete).toBe(true);
  });
  it("退出失败恢复运行标记，下一次启动仍可发现未正常退出", async () => {
    const { service, saved } = setup();
    await service.initialize();
    await service.prepareExit();
    expect(saved().session.clean).toBe(true);
    service.resumeAfterFailedExit();
    await vi.advanceTimersByTimeAsync(251);
    expect(saved().session.clean).toBe(false);
  });
  it("损坏历史不覆盖，保存失败不会递归生成更多反馈", async () => {
    const corrupt = setup({ schema: 99 });
    await corrupt.service.initialize();
    corrupt.service.capture(failure);
    await vi.advanceTimersByTimeAsync(3001);
    expect(corrupt.port.write).not.toHaveBeenCalled();
    expect(corrupt.service.getSnapshot().error).toContain("原文件已保留");
    const broken = setup();
    broken.port.write.mockRejectedValue(new Error("模拟磁盘写入失败"));
    await broken.service.initialize();
    broken.service.capture(failure);
    await vi.advanceTimersByTimeAsync(3001);
    expect(broken.service.getSnapshot().reports).toHaveLength(1);
    expect(broken.service.getSnapshot().error).toContain("保存失败");
  });
  it("过期记录在读取时清理", async () => {
    const first = setup();
    await first.service.initialize();
    first.service.capture(failure);
    await first.service.prepareExit();
    vi.setSystemTime(time + 8 * 86400000);
    const next = setup(first.saved());
    await next.service.initialize();
    expect(next.service.getSnapshot().reports).toHaveLength(0);
  });
  it("系统信息超时只降低报告完整度，不阻塞反馈", async () => {
    const { service, port } = setup();
    port.system.mockImplementation(() => new Promise(() => {}));
    const initializing = service.initialize();
    await vi.advanceTimersByTimeAsync(3001);
    await initializing;
    const id = service.capture(failure);
    expect(service.preview(id)).toContain("部分系统信息未能取得");
    await service.submit(id);
    expect(port.open).toHaveBeenCalledOnce();
  });
  it("关键模块错误进入统一反馈，中间重试和取消不触发", () => {
    const entry = {
      ...log("安全故障"),
      session: "safe-session",
      sequence: 1,
      time: new Date(time).toISOString(),
    } as LogEntry;
    for (const module of [
      "database",
      "library",
      "playback",
      "backup",
      "updates",
      "settings",
      "frontend",
      "metatube",
      "ai",
    ])
      expect(failureFromLog({ ...entry, module, event: "failed", level: "error" })).toBeDefined();
    expect(failureFromLog({ ...entry, level: "error" })).toBeUndefined();
    expect(
      failureFromLog({ ...entry, module: "scraping", level: "warn", event: "needsInput" }),
    ).toBeUndefined();
    expect(
      failureFromLog({ ...entry, module: "scraping", level: "info", event: "cancelled" }),
    ).toBeUndefined();
    expect(
      failureFromLog({ ...entry, module: "scraping", level: "warn", event: "partial" }),
    ).toBeDefined();
  });
  it("长日志与恶意围栏不会突破报告上限", async () => {
    const { service, logs } = setup();
    await service.initialize();
    for (let i = 0; i < 500; i++) logs.record(log("安全文本".repeat(500)));
    const id = service.capture({ ...failure, message: "```\n# 伪造段落\n```" });
    for (let i = 0; i < 500; i++) logs.record(log("后续安全文本".repeat(400)));
    const report = service.getSnapshot().reports.find((item) => item.id === id)!;
    expect(report.before.length).toBeLessThanOrEqual(feedbackPolicy.before);
    expect(report.after.length).toBeLessThanOrEqual(feedbackPolicy.after);
    expect(service.preview(id).length).toBeLessThan(45000);
    expect(service.preview(id)).toContain("ˋˋˋ");
    expect(diagnosticText("Authorization: Bearer fictional-secret")).not.toContain(
      "fictional-secret",
    );
  });
  it("手动再次打开旧下载沿用已保存快照", async () => {
    const { service } = setup();
    await service.initialize();
    setFailureSink(service.capture);
    const task = createDownloadTasks(
      { urls: [link], directory: "E:/safe-fixtures", kind: "hls", headers: {} },
      [],
    )[0]!;
    const failed = { ...task, status: "failed" as const, error: failure.message };
    const first = reportDownloadFailure(failed);
    await vi.advanceTimersByTimeAsync(65000);
    const second = reportDownloadFailure(failed, true);
    expect(second).toBe(first);
    expect(service.getSnapshot().reports).toHaveLength(1);
  });
  it("下载状态保存较慢时仍采集本次失败快照", async () => {
    const { service, logs } = setup();
    await service.initialize();
    setFailureSink(service.capture);
    const task = createDownloadTasks(
      { urls: [link], directory: "E:/safe-fixtures", kind: "hls", headers: {} },
      [],
    )[0]!;
    const failed = {
      ...task,
      status: "failed" as const,
      error: failure.message,
      updatedAt: new Date(time - 60000).toISOString(),
    };
    logs.record(log("状态保存后记录的故障事件", { taskId: task.id }));
    const id = reportDownloadFailure(failed)!;
    expect(service.getSnapshot().reports[0]!.complete).toBe(false);
    expect(service.preview(id)).toContain("状态保存后记录的故障事件");
    expect(service.preview(id)).not.toContain("任务失败时未保存系统信息");
    await vi.advanceTimersByTimeAsync(65000);
    expect(reportDownloadFailure(failed, true)).toBe(id);
  });
  it("真实下载服务的最终失败提交报告，暂停不会创建报告", async () => {
    const { service, logs } = setup();
    await service.initialize();
    setFailureSink(service.capture);
    setLogSink(logs.record);
    const tasks = new Map<string, DownloadTask>();
    const repository: DownloadRepository = {
      load: async () => ({
        tasks: [],
        settings: { ...defaultDownloadSettings, directory: "E:/safe-fixtures" },
      }),
      save: async (task) => {
        tasks.set(task.id, task);
      },
      remove: async () => {},
      saveSettings: async () => {},
      close: async () => {},
    };
    let fail = true;
    const engine: DownloadEngine = {
      defaultDirectory: async () => "E:/safe-fixtures",
      outputSize: async () => null,
      checkTools: async () => [],
      open: async () => {},
      run: async (_task, _settings, signal, progress, stage) => {
        await stage("download");
        progress({ line: "error: 首次失败，正在自动重试" });
        if (fail) throw new Error(failure.message);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    };
    const downloads = new DownloadService(repository, engine);
    await downloads.initialize();
    await downloads.add({ urls: [link], directory: "E:/safe-fixtures", kind: "hls", headers: {} });
    await vi.advanceTimersByTimeAsync(20);
    expect(service.getSnapshot().reports).toHaveLength(1);
    expect(service.getSnapshot().reports[0]!.url).toBe(link);
    fail = false;
    const id = [...tasks.keys()][0]!;
    await downloads.resume(id);
    await vi.advanceTimersByTimeAsync(20);
    await downloads.pause(id);
    expect(downloads.getSnapshot().tasks[0]!.status).toBe("paused");
    expect(service.getSnapshot().reports).toHaveLength(1);
    await downloads.shutdown();
  });
});
