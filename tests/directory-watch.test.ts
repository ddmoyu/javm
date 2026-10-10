import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DirectoryWatchService } from "../frontend/src/services/library/DirectoryWatchService";
import type { WatchEvent } from "../frontend/src/services/library/DirectoryWatchService";
import type { LibraryService } from "../frontend/src/services/library/LibraryService";

function fixture() {
  let listener: (event: WatchEvent) => void = () => {};
  const subscriptions = new Set<() => void>();
  const state = {
    directories: [{ id: "safe", path: "C:/safe-fixture", recursive: true }],
    scan: null as null | { state: string },
  };
  const scan = vi.fn(async () => {
    state.scan = { state: "scanning" };
  });
  const library = {
    initialize: async () => {},
    getSnapshot: () => state,
    scan,
    subscribe: (fn: () => void) => {
      subscriptions.add(fn);
      return () => {
        subscriptions.delete(fn);
      };
    },
  } as unknown as LibraryService;
  const remove = vi.fn(async () => {}),
    close = vi.fn(async () => {}),
    create = vi.fn(async () => 1);
  const service = new DirectoryWatchService(
    library,
    {
      create,
      remove,
      listen: async (fn) => {
        listener = fn;
        return close;
      },
    },
    { read: async () => ({ enabled: true }), write: async () => {} },
  );
  const change = (filename = "SAFE-001.mp4", dir = "C:/safe-fixture") =>
    listener({ id: 1, action: "modified", dir, filename });
  return { service, scan, state, change, create, remove, close, subscriptions };
}
describe("目录监听调度（安全 mock，无实际磁盘监听）", () => {
  afterEach(() => vi.useRealTimers());
  it("突发变化合并为一次扫描，扫描期间的变化等待前一任务结束", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.service.initialize();
      for (let i = 0; i < 100; i++) f.change();
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.scan).toHaveBeenCalledTimes(1);
      f.change();
      await vi.advanceTimersByTimeAsync(12_000);
      expect(f.scan).toHaveBeenCalledTimes(1);
      f.state.scan = null;
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.scan).toHaveBeenCalledTimes(2);
    } finally {
      await f.service.shutdown();
    }
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledWith(1);
    expect(f.subscriptions.size).toBe(0);
  });
  it("忽略临时文件与非递归根的子目录，关闭后清空排队", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.state.directories[0]!.recursive = false;
    try {
      await f.service.initialize();
      f.change("working.part");
      f.change("nested.mp4", "C:/safe-fixture/sub");
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.scan).not.toHaveBeenCalled();
      f.change();
      await f.service.setEnabled(false);
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.scan).not.toHaveBeenCalled();
      expect(f.service.getSnapshot().queued).toBe(0);
    } finally {
      await f.service.shutdown();
    }
  });
  it("失败重试有上限，关闭期间未完成创建的监听也会回收", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.scan.mockRejectedValue(new Error("离线"));
    try {
      await f.service.initialize();
      f.change();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(f.scan).toHaveBeenCalledTimes(3);
      expect(f.service.getSnapshot().queued).toBe(0);
    } finally {
      await f.service.shutdown();
    }
    const late = fixture();
    let finish: (value: number) => void = () => {};
    late.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const starting = late.service.initialize();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const stopping = late.service.shutdown();
    finish(1);
    await starting;
    await stopping;
    expect(late.remove).toHaveBeenCalledWith(1);
    expect(late.subscriptions.size).toBe(0);
  });
});
