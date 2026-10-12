import { afterEach, expect, it, vi } from "vite-plus/test";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import { loadDiscovery } from "../frontend/src/services/catalog/discoveryData";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

it("内置 SQLite 批次未完成时拒绝加载，重试可重置半成品", async () => {
  vi.stubEnv("DEV", false);
  vi.resetModules();
  const { loadJavbusSeed: load, appendJavbusSeed: append } =
    await import("../frontend/src/services/catalog/javbusSeed");
  await expect(load()).rejects.toThrow("尚未就绪");
  append([], true, false);
  await expect(load()).rejects.toThrow("尚未就绪");
  append([], true, true);
  expect(await load()).toEqual([]);
});

it("初始化失败后可恢复缓存读取，并清除加载失败提示", async () => {
  vi.useFakeTimers();
  const data = loadDiscovery(
    { genres: [], actors: [], entities: [{ dimension: "labels", name: "安全发行商" }] },
    null,
    Date.now(),
  );
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error("Safe fixture failure"))
    .mockResolvedValue(data);
  const read = vi.fn(async () => null);
  const service = new DiscoveryCatalogService(
    { run: run as CatalogProcessor["run"], close: vi.fn() },
    { read, write: vi.fn(), fetch: vi.fn() },
  );
  try {
    await service.initialize();
    expect(service.getSnapshot().ready).toBe(false);
    expect(service.getSnapshot().warning).toContain("内置名单加载失败");
    expect(read).not.toHaveBeenCalled();
    await service.initialize();
    expect(service.getSnapshot().ready).toBe(true);
    expect(service.getSnapshot().warning).toBe("");
    expect(service.getSnapshot().catalogs.labels.names).toEqual(["安全发行商"]);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await service.shutdown();
  }
});
