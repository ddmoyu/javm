import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FeedbackJournal } from "../frontend/src/services/feedback/persistence";
import type { FeedbackFiles } from "../frontend/src/services/feedback/persistence";
import { FeedbackService } from "../frontend/src/services/feedback/FeedbackService";
import type { FeedbackState } from "../frontend/src/services/feedback/FeedbackService";
import { LogService } from "../frontend/src/services/logging/LogService";

const services: FeedbackService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});
function fixture() {
  const files = new Map<string, string>();
  const io = {
    list: async () => [...files.keys()],
    read: async (name: string) => files.get(name)!,
    write: vi.fn(async (name: string, text: string) => {
      files.set(name, text);
    }),
    remove: vi.fn(async (name: string) => {
      files.delete(name);
    }),
  } satisfies FeedbackFiles;
  const legacy = vi.fn(async (): Promise<unknown> => null);
  const open = () => new FeedbackJournal(io, legacy);
  const create = (journal: FeedbackJournal) => {
    const service = new FeedbackService(new LogService(), {
      read: journal.read,
      begin: journal.begin,
      write: journal.write,
      warning: journal.warning,
      system: async () => ({ 操作系统: "Safe Test OS" }),
      copy: async () => {},
      open: async () => {},
    });
    services.push(service);
    return service;
  };
  return { files, io, legacy, open, create };
}
const state = (): FeedbackState => ({
  schema: 1,
  reports: [],
  session: {
    id: crypto.randomUUID(),
    startedAt: "2026-10-15T06:00:00.000Z",
    clean: false,
    system: { 操作系统: "Safe OS" },
  },
});
const failure = {
  module: "downloads",
  title: "安全下载失败",
  message: "缺少分片",
  url: "https://media.example.invalid/demo.m3u8?token=full-safe-token",
};

describe("反馈可恢复存储", () => {
  it("初次运行标记暂时写入失败不会禁用后续保存", async () => {
    const f = fixture();
    vi.mocked(f.io.write).mockRejectedValueOnce(new Error("安全模拟文件暂时占用"));
    const service = f.create(f.open());
    await service.initialize();
    expect(service.getSnapshot().error).toContain("运行标记保存失败");
    service.capture(failure);
    await service.resumeAfterFailedExit();
    const saved = await f.open().read();
    expect(saved?.session.clean).toBe(false);
    expect(saved?.reports[0]?.url).toBe(failure.url);
    expect(service.getSnapshot().error).toBe("");
  });
  it("退出被拒绝后立即恢复独立标记，不等待保存防抖", async () => {
    const f = fixture(),
      service = f.create(f.open());
    await service.initialize();
    await service.prepareExit();
    expect([...f.files.keys()].some((name) => name.startsWith("session-"))).toBe(false);
    await service.resumeAfterFailedExit();
    expect((await f.open().read())?.session.clean).toBe(false);
  });
  it("新快照写到一半时回退完整快照，独立标记仍恢复异常退出", async () => {
    const f = fixture(),
      journal = f.open(),
      original = state();
    await journal.read();
    await journal.write(original);
    vi.mocked(f.io.write).mockImplementationOnce(async (name, text) => {
      f.files.set(name, text.slice(0, 30));
      throw new Error("模拟写入中断");
    });
    await expect(journal.write(original)).rejects.toThrow("写入中断");
    const restored = await f.open().read();
    expect(restored?.session).toEqual(original.session);
    const next = f.create(f.open());
    await next.initialize();
    expect(next.getSnapshot().reports[0]?.title).toBe("上次未正常退出");
    expect(next.getSnapshot().reports[0]?.system.操作系统).toBe("Safe OS");
  });
  it("最新快照内容被改写时校验失败，保留前一代报告", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      service = f.create(f.open());
    await service.initialize();
    service.capture(failure);
    await vi.advanceTimersByTimeAsync(3001);
    await service.prepareExit();
    const latest = [...f.files.keys()]
      .filter((name) => name.startsWith("report-"))
      .sort()
      .at(-1)!;
    f.files.set(latest, f.files.get(latest)!.replace("缺少分片", "伪造记录"));
    const journal = f.open(),
      restored = await journal.read();
    expect(restored?.reports[0]?.message).toBe("缺少分片");
    expect(restored?.session.clean).toBe(true);
    expect(journal.warning()).toContain("不完整");
  });
  it("首次标记正文损坏且报告尚未写入，也能发现上次未退出", async () => {
    const f = fixture(),
      original = state();
    f.files.set(
      `session-${Date.parse(original.session.startedAt)}-${original.session.id}.json`,
      '{"schema":',
    );
    const restored = await f.open().read();
    expect(restored?.session).toMatchObject({
      id: original.session.id,
      clean: false,
      startedAt: original.session.startedAt,
    });
    expect(restored?.reports).toEqual([]);
  });
  it("正常退出在报告写入失败时也删除本次标记，恢复运行可再次建立标记", async () => {
    const f = fixture(),
      journal = f.open(),
      original = state();
    await journal.read();
    await journal.write(original);
    vi.mocked(f.io.write).mockRejectedValueOnce(new Error("磁盘空间不足"));
    await expect(
      journal.write({ ...original, session: { ...original.session, clean: true } }),
    ).rejects.toThrow();
    expect((await f.open().read())?.session.clean).toBe(true);
    await journal.write(original);
    expect((await f.open().read())?.session.clean).toBe(false);
  });
  it("新快照确认前保留上次标记，确认后文件数有界并不重复提示旧崩溃", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      original = state(),
      first = f.open();
    await first.read();
    await first.write(original);
    const service = f.create(f.open());
    await service.initialize();
    expect([...f.files.keys()].filter((name) => name.startsWith("session-")).length).toBe(2);
    for (let i = 0; i < 12; i++) {
      service.capture({ ...failure, message: `安全故障 ${i}` });
      await vi.advanceTimersByTimeAsync(3001);
    }
    // 校验中的新文件可以暂时与两份备份并存。
    expect(
      [...f.files.keys()].filter((name) => name.startsWith("report-")).length,
    ).toBeLessThanOrEqual(3);
    expect([...f.files.keys()].filter((name) => name.startsWith("session-")).length).toBe(1);
    await service.prepareExit();
    expect([...f.files.keys()].filter((name) => name.startsWith("report-")).length).toBe(2);
    const next = f.create(f.open());
    await next.initialize();
    expect(next.getSnapshot().activeId).toBeUndefined();
    expect(next.getSnapshot().reports.length).toBeLessThanOrEqual(8);
  });
  it("旧格式可迁移，损坏旧格式不再永久禁用新报告保存", async () => {
    const f = fixture(),
      old = state();
    f.legacy.mockResolvedValue(old);
    expect((await f.open().read())?.session.id).toBe(old.session.id);
    f.legacy.mockRejectedValue(new Error("旧 JSON 损坏"));
    const journal = f.open();
    expect(await journal.read()).toBeNull();
    expect(journal.warning()).toContain("原文件已保留");
    await journal.write(old);
    expect((await f.open().read())?.session.id).toBe(old.session.id);
  });
  it("初始化先创建标记，再等待系统信息；更新门闩超过三秒不禁用保存", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      journal = f.open();
    let release!: () => void;
    const startup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const system = vi.fn(async () => ({ 操作系统: "Safe OS" }));
    const service = new FeedbackService(new LogService(), {
      startup: () => startup,
      read: journal.read,
      begin: journal.begin,
      write: journal.write,
      system,
      copy: async () => {},
      open: async () => {},
    });
    services.push(service);
    const pending = service.initialize();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.files.size).toBe(0);
    expect(system).not.toHaveBeenCalled();
    system.mockImplementation(async () => {
      expect([...f.files.keys()].some((name) => name.startsWith("session-"))).toBe(true);
      return { 操作系统: "Safe OS" };
    });
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(251);
    await service.prepareExit();
    expect(service.getSnapshot().error).toBe("");
    expect([...f.files.keys()].some((name) => name.startsWith("report-"))).toBe(true);
  });
});
