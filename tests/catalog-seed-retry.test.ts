import { afterEach, expect, it, vi } from "vite-plus/test";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import { loadDiscovery } from "../frontend/src/services/catalog/discoveryData";
import { javbusCsvColumns } from "../frontend/src/services/catalog/javbusCatalog";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

it.each(["javbus", "avwiki"] as const)("%s 内置 CSV 读取失败后重试会重新读取文件", async (kind) => {
  vi.stubEnv("DEV", false);
  vi.resetModules();
  const dimensions: Record<string, string> = {
    "actresses.csv": "actor",
    "male-actors.csv": "histrion",
    "directors.csv": "director",
    "makers.csv": "maker",
    "series.csv": "series",
  };
  const fetch = vi.fn(async (input: string) => {
    if (kind === "javbus") return new Response(javbusCsvColumns.join(",") + "\r\n");
    const name = Object.keys(dimensions).find((file) => input.endsWith(file));
    const dimension = dimensions[name ?? ""];
    if (!dimension) throw new Error("Unexpected safe fixture URL");
    return new Response(
      "source,kind,source_id,name_original,name_zh,aliases,translation_status,source_url\r\n" +
        `avwikidb,${dimension},1,安全示例,,,pending,https://avwikidb.com/${dimension}/1/\r\n`,
    );
  });
  fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const load =
    kind === "javbus"
      ? (await import("../frontend/src/services/catalog/javbusSeed")).loadJavbusSeed
      : (await import("../frontend/src/services/catalog/avwikiSeed")).loadAvwikiSeed;
  const failed = load();
  expect(load()).toBe(failed);
  await expect(failed).rejects.toThrow("内置目录读取失败");
  const recovered = await load();
  expect(await load()).toBe(recovered);
  expect(fetch).toHaveBeenCalledTimes(kind === "javbus" ? 8 : 6);
});

it("初始化失败后可恢复缓存读取，并清除加载失败提示", async () => {
  vi.useFakeTimers();
  const data = loadDiscovery(
    { genres: [], actors: [], actorDirectories: { actresses: ["安全演员"] }, entities: [] },
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
    expect(service.getSnapshot().catalogs.actresses.names).toEqual(["安全演员"]);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await service.shutdown();
  }
});
