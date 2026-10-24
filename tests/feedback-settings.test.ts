import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FeedbackService } from "../frontend/src/services/feedback/FeedbackService";
import type { FeedbackState } from "../frontend/src/services/feedback/FeedbackService";
import { FeedbackJournal } from "../frontend/src/services/feedback/persistence";
import { LogService } from "../frontend/src/services/logging/LogService";

const failure = { module: "frontend", title: "安全示例异常", message: "模拟界面故障" };
const services: FeedbackService[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T06:00:00Z"));
});
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(initial: unknown = null) {
  let preference = initial;
  let saved: FeedbackState | null = null;
  const settings = {
    read: vi.fn(async (): Promise<unknown> => preference),
    write: vi.fn(async (value: { enabled: boolean }) => {
      preference = value;
    }),
  };
  const create = () => {
    const logs = new LogService();
    const unlisten = vi.fn();
    const port = {
      settings,
      startup: vi.fn(async () => {}),
      listen: vi.fn(() => unlisten),
      read: vi.fn(async () => saved),
      begin: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      write: vi.fn(async (value: FeedbackState) => {
        saved = structuredClone(value);
      }),
      system: vi.fn(async () => ({ 系统: "Safe mock OS" })),
      copy: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
    };
    const service = new FeedbackService(logs, port);
    services.push(service);
    return { service, port, logs, unlisten };
  };
  return { ...create(), create, settings };
}

describe("反馈开关与诊断生命周期", () => {
  it("等待读取开关期间及已关闭启动时，不采集诊断或建立会话标记", async () => {
    const { service, port, settings, logs } = fixture();
    const reading = deferred<unknown>();
    settings.read.mockReturnValue(reading.promise);
    const initialize = service.initialize();
    expect(service.capture(failure, true)).toBeUndefined();
    logs.record({ ...failure, event: "uncaught", level: "error" });
    reading.resolve({ enabled: false });
    await initialize;
    await service.prepareExit();
    await service.resumeAfterFailedExit();
    expect(service.capture(failure, true)).toBeUndefined();
    expect(service.getSnapshot()).toMatchObject({
      enabled: false,
      settingsReady: true,
      reports: [],
    });
    for (const method of [
      port.startup,
      port.listen,
      port.read,
      port.begin,
      port.system,
      port.write,
      port.end,
    ])
      expect(method).not.toHaveBeenCalled();
    expect(settings.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("未设置时默认开启，重复初始化只启动一次诊断", async () => {
    const { service, port } = fixture();
    await Promise.all([service.initialize(), service.initialize()]);
    expect(service.getSnapshot().enabled).toBe(true);
    expect(port.begin).toHaveBeenCalledOnce();
    expect(port.listen).toHaveBeenCalledOnce();
    const id = service.capture(failure);
    expect(id).toBeTruthy();
    expect(service.getSnapshot().activeId).toBe(id);
  });

  it("关闭后收起弹框，停止监听与定时采集，手动入口和退出流程也不会重新启用", async () => {
    const { service, port, logs, settings, unlisten } = fixture();
    await service.initialize();
    const id = service.capture(failure);
    await service.setEnabled(false);
    expect(settings.write).toHaveBeenCalledWith({ enabled: false });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(port.end).toHaveBeenCalledOnce();
    expect(service.getSnapshot().activeId).toBeUndefined();
    const stopped = service.getSnapshot().reports;
    port.write.mockClear();
    port.system.mockClear();
    logs.record({ ...failure, event: "uncaught", level: "error" });
    expect(service.capture(failure, true)).toBeUndefined();
    service.open(id);
    await service.submit(id);
    await service.prepareExit();
    await service.resumeAfterFailedExit();
    await vi.advanceTimersByTimeAsync(3600001);
    expect(service.getSnapshot().reports).toEqual(stopped);
    expect(service.getSnapshot().activeId).toBeUndefined();
    for (const method of [port.write, port.system, port.copy, port.open])
      expect(method).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("保存后重启仍关闭，重新开启恢复历史但不补报遗留的异常退出", async () => {
    const f = fixture();
    await f.service.initialize();
    const id = f.service.capture(failure);
    await vi.advanceTimersByTimeAsync(3001);
    await f.service.setEnabled(false);
    const next = f.create();
    await next.service.initialize();
    expect(next.service.getSnapshot().enabled).toBe(false);
    expect(next.port.read).not.toHaveBeenCalled();
    await next.service.setEnabled(true);
    expect(next.service.getSnapshot().reports.map((item) => item.id)).toEqual([id]);
    expect(next.service.getSnapshot().activeId).toBeUndefined();
    await next.service.setEnabled(false);
    await next.service.setEnabled(true);
    expect(next.service.getSnapshot().reports).toHaveLength(1);
    expect(next.port.listen).toHaveBeenCalledTimes(2);
    const newId = next.service.capture({ ...failure, message: "重新开启后的新故障" });
    expect(next.service.getSnapshot().activeId).toBe(newId);
  });

  it.each([false, true])("保存失败时保留原开关状态 %s，不改变诊断生命周期", async (enabled) => {
    const { service, port, settings } = fixture({ enabled });
    await service.initialize();
    settings.write.mockRejectedValue(new Error("模拟保存失败"));
    await expect(service.setEnabled(!enabled)).rejects.toThrow("模拟保存失败");
    expect(service.getSnapshot()).toMatchObject({ enabled, savingSettings: false });
    expect(service.getSnapshot().settingsError).toContain("仍使用原设置");
    expect(port.end).not.toHaveBeenCalled();
    expect(port.begin).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it("设置格式损坏时保留原配置，不默认开启崩溃记录", async () => {
    const { service, settings, port } = fixture({ enabled: "false" });
    await service.initialize();
    expect(service.getSnapshot().enabled).toBe(false);
    expect(service.getSnapshot().settingsError).toContain("无法读取反馈设置");
    expect(settings.write).not.toHaveBeenCalled();
    expect(port.read).not.toHaveBeenCalled();
    expect(port.listen).not.toHaveBeenCalled();
  });

  it("关闭先停止采集，等旧写入结束后再清理标记，避免留下假的崩溃标记", async () => {
    const { service, port } = fixture();
    await service.initialize();
    const writing = deferred<void>();
    port.write.mockReturnValue(writing.promise);
    await vi.advanceTimersByTimeAsync(251);
    expect(port.write).toHaveBeenCalledOnce();
    const closing = service.setEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getSnapshot().enabled).toBe(false);
    expect(service.capture(failure)).toBeUndefined();
    expect(port.end).not.toHaveBeenCalled();
    writing.resolve();
    await closing;
    expect(port.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("关闭前发出的系统信息请求晚到时，不改写已停止的诊断", async () => {
    const { service, port } = fixture();
    await service.initialize();
    await vi.advanceTimersByTimeAsync(5001);
    const system = deferred<{ 系统: string }>();
    port.system.mockReturnValue(system.promise);
    service.capture(failure);
    await service.setEnabled(false);
    const reports = service.getSnapshot().reports;
    port.write.mockClear();
    system.resolve({ 系统: "Late mock OS" });
    await vi.advanceTimersByTimeAsync(3001);
    expect(service.getSnapshot().reports).toEqual(reports);
    expect(port.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("清理当前与旧会话标记时保留历史快照，重复启用不会损坏快照索引", async () => {
    const files = new Map<string, string>();
    const io = {
      list: async () => [...files.keys()],
      read: async (name: string) => files.get(name)!,
      write: async (name: string, text: string) => {
        files.set(name, text);
      },
      remove: async (name: string) => {
        files.delete(name);
      },
    };
    const state: FeedbackState = {
      schema: 1,
      session: {
        id: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        clean: false,
        system: {},
      },
      reports: [],
    };
    const first = new FeedbackJournal(io);
    await first.read();
    await first.write(state);
    const journal = new FeedbackJournal(io);
    await journal.read();
    await journal.begin({ ...state.session, id: crypto.randomUUID() });
    expect([...files.keys()].filter((name) => name.startsWith("session-"))).toHaveLength(2);
    await journal.end();
    expect([...files.keys()].filter((name) => name.startsWith("session-"))).toHaveLength(0);
    expect([...files.keys()].filter((name) => name.startsWith("report-"))).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      expect((await journal.read())?.session.clean).toBe(true);
      await journal.write(state);
      await journal.end();
    }
    const restored = await new FeedbackJournal(io).read();
    expect(restored).toEqual({ ...state, session: { ...state.session, clean: true } });
    expect([...files.keys()].filter((name) => name.startsWith("report-"))).toHaveLength(2);
  });
});
