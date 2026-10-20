import { afterEach, expect, it, vi } from "vite-plus/test";
import { DirectoryWatchService } from "../frontend/src/services/library/DirectoryWatchService";
import type { WatchEvent } from "../frontend/src/services/library/DirectoryWatchService";
import type { LibraryService } from "../frontend/src/services/library/LibraryService";
afterEach(() => vi.useRealTimers());
it("离线目录丢弃旧监听，重连后重建并继续扫描，后台三十分钟没有无限排队", async () => {
  vi.useFakeTimers();
  let online = true;
  let changed: (event: WatchEvent) => void = () => {};
  const scan = vi.fn(async () => {});
  const create = vi.fn(async () => {
    if (!online) throw new Error("安全模拟离线");
    return create.mock.calls.length;
  });
  const remove = vi.fn(async () => {});
  const state = { directories: [{ id: "safe", path: "C:/safe", recursive: true }], scan: null };
  const library = {
    initialize: async () => {},
    getSnapshot: () => state,
    scan,
    subscribe: () => () => {},
  } as unknown as LibraryService;
  const service = new DirectoryWatchService(
    library,
    {
      create,
      remove,
      online: async () => online,
      listen: async (listener) => {
        changed = listener;
        return async () => {};
      },
    },
    { read: async () => ({ enabled: true }), write: async () => {} },
  );
  try {
    await service.initialize();
    online = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(remove).toHaveBeenCalledWith(1);
    expect(service.getSnapshot().watching).toBe(0);
    online = true;
    await vi.advanceTimersByTimeAsync(60000);
    expect(service.getSnapshot().watching).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
    for (let minute = 0; minute < 30; minute++) {
      for (let n = 0; n < 100; n++)
        changed({
          id: create.mock.calls.length,
          action: "modified",
          dir: "C:/safe",
          filename: "SAFE-001.mp4",
        });
      expect(service.getSnapshot().queued).toBe(1);
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(scan).toHaveBeenCalledTimes(31);
    expect(service.getSnapshot().queued).toBe(0);
  } finally {
    await service.shutdown();
  }
});
