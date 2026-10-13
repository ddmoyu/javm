import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { events, extensions, filesystem, os } from "@neutralinojs/lib";
import { NativeDownloadRepository } from "../frontend/src/platform/neutralino/downloadRepository";
import {
  recoverNativeProcesses,
  runNativeProcess,
} from "../frontend/src/platform/neutralino/process";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { deferred } from "./helpers/deferred";

vi.mock("@neutralinojs/lib", () => ({
  events: { on: vi.fn(), off: vi.fn() },
  extensions: { dispatch: vi.fn() },
  filesystem: { writeFile: vi.fn(), remove: vi.fn() },
  os: {
    getPath: vi.fn(),
    getSpawnedProcesses: vi.fn(),
    updateSpawnedProcess: vi.fn(),
    execCommand: vi.fn(),
    spawnProcess: vi.fn(),
  },
}));

const listeners = new Map<string, (event: CustomEvent) => void>();
const session = new Map<string, string>();
const registry = "javm:download-processes:123";
const worker = { id: 42, pid: 4242 };
beforeEach(() => {
  vi.resetAllMocks();
  listeners.clear();
  session.clear();
  vi.stubGlobal("window", { NL_PID: "123", NL_OS: "Windows" });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  });
  vi.mocked(events.on).mockImplementation(async (name, listener) => {
    listeners.set(name, listener);
    return { success: true, message: "" };
  });
  vi.mocked(events.off).mockImplementation(async (name) => {
    listeners.delete(name);
    return { success: true, message: "" };
  });
  vi.mocked(os.getSpawnedProcesses).mockResolvedValue([]);
  vi.mocked(os.updateSpawnedProcess).mockResolvedValue(undefined);
  vi.mocked(os.getPath).mockResolvedValue("E:/download-reliability");
  vi.mocked(filesystem.writeFile).mockResolvedValue(undefined);
  vi.mocked(filesystem.remove).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("下载数据库分页适配", () => {
  it("分页读取全部记录并让出事件循环，恢复读库不回收其他服务的新进程", async () => {
    const base = createDownloadTasks(
      {
        urls: ["https://example.invalid/video.mp4"],
        directory: "E:/fixture",
        kind: "auto",
        headers: {},
      },
      [],
    )[0]!;
    const tasks = Array.from({ length: 215 }, (_, index) => ({
      ...base,
      id: String(index),
      log: [],
    }));
    const offsets: number[] = [];
    let yielded = true;
    vi.mocked(extensions.dispatch).mockImplementation(async (_id, _event, data) => {
      const { requestId, method, params } = data as {
        requestId: string;
        method: string;
        params: { offset?: number };
      };
      let result: unknown = {};
      if (method === "downloads.load") {
        expect(yielded).toBe(true);
        yielded = false;
        setTimeout(() => {
          yielded = true;
        }, 0);
        const offset = params.offset!;
        offsets.push(offset);
        result = {
          tasks: tasks.slice(offset, offset + 100),
          settings: { directory: "E:/fixture" },
          nextOffset: offset + 100 < tasks.length ? offset + 100 : null,
        };
      }
      listeners.get("javm.database.response")!(
        new CustomEvent("reply", { detail: { requestId, ok: true, result } }),
      );
    });
    const repository = new NativeDownloadRepository();
    expect((await repository.load()).tasks).toEqual(tasks);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await repository.load()).tasks).toEqual(tasks);
    expect(offsets).toEqual([0, 100, 200, 0, 100, 200]);
    expect(os.getSpawnedProcesses).toHaveBeenCalledOnce();
    await repository.close();
  });

  it.each([undefined, 0, 101])("拒绝不前进或不兼容的分页游标 %s", async (nextOffset) => {
    vi.mocked(extensions.dispatch).mockImplementation(async (_id, _event, data) => {
      const { requestId, method } = data as { requestId: string; method: string };
      const result = method === "downloads.load" ? { tasks: [], settings: {}, nextOffset } : {};
      listeners.get("javm.database.response")!(
        new CustomEvent("reply", { detail: { requestId, ok: true, result } }),
      );
    });
    const repository = new NativeDownloadRepository();
    await expect(repository.load()).rejects.toThrow("分页响应无效");
    await repository.close();
  });
});

describe("下载监督进程的取消", () => {
  it("启动响应尚未返回时取消，取得运行标识后发送 EOF 并等待退出", async () => {
    const spawned = deferred<typeof worker>();
    vi.mocked(os.spawnProcess).mockReturnValue(spawned.promise);
    vi.mocked(os.getSpawnedProcesses).mockResolvedValue([worker]);
    vi.mocked(os.updateSpawnedProcess).mockImplementation(async () => {
      listeners.get("spawnedProcess")!(
        new CustomEvent("process", { detail: { id: worker.id, action: "exit", data: 1 } }),
      );
    });
    const controller = new AbortController();
    const running = runNativeProcess("curl.exe", [], controller.signal, undefined, true);
    await vi.waitFor(() => expect(os.spawnProcess).toHaveBeenCalledOnce());
    controller.abort();
    spawned.resolve(worker);
    await running;
    expect(os.updateSpawnedProcess).toHaveBeenCalledWith(worker.id, "stdInEnd");
    expect(os.execCommand).not.toHaveBeenCalled();
    expect(JSON.parse(session.get(registry)!)).toEqual([]);
  });

  it("页面重载使用登记的协作取消，确认退出后才清除记录", async () => {
    session.set(registry, JSON.stringify([{ ...worker, cooperativeCancel: true }]));
    vi.mocked(os.getSpawnedProcesses)
      .mockResolvedValueOnce([worker])
      .mockResolvedValueOnce([worker])
      .mockResolvedValue([]);
    await recoverNativeProcesses();
    expect(os.updateSpawnedProcess).toHaveBeenCalledWith(worker.id, "stdInEnd");
    expect(os.execCommand).not.toHaveBeenCalled();
    expect(session.has(registry)).toBe(false);
  });

  it("重载取消超时保留进程登记，不强杀外层进程或宣称已恢复", async () => {
    vi.useFakeTimers();
    session.set(registry, JSON.stringify([{ ...worker, cooperativeCancel: true }]));
    vi.mocked(os.getSpawnedProcesses).mockResolvedValue([worker]);
    const result = expect(recoverNativeProcesses()).rejects.toThrow("尚未停止");
    await vi.advanceTimersByTimeAsync(5500);
    await result;
    expect(session.has(registry)).toBe(true);
    expect(os.execCommand).not.toHaveBeenCalled();
  });
});
