import { expect, it, vi } from "vite-plus/test";
import {
  loadDiscovery,
  nativeCatalogOverrides,
  retainLegacyJavbusEntries,
} from "../frontend/src/services/catalog/discoveryData";
import { OnlineActorSearchService } from "../frontend/src/services/catalog/OnlineActorSearchService";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";
import type { JavbusCatalogEntry } from "../frontend/src/services/catalog/javbusCatalog";

const now = Date.now();
const entry = (id: string, videoCount?: number): JavbusCatalogEntry => ({
  dimension: "actresses",
  lane: "censored",
  id,
  name: `安全演员${id}`,
  label: `安全演员${id}`,
  aliases: [],
  translationStatus: "pending",
  category: "",
  ...(videoCount === undefined ? {} : { videoCount, countUpdatedAt: now }),
});
const seed = { actors: [], genres: [], entities: [], javbusEntries: [entry("known", 0)] };

it("SQLite Worker 失效后重新分批装载，旧缓存读取失败不完成迁移", async () => {
  const data = loadDiscovery(seed, null, now);
  let failed!: () => void;
  const processor: CatalogProcessor = {
    run: vi.fn(async (operation: string) =>
      operation === "javbusSeedAppend" ? true : operation === "javbusImportCsv" ? [] : data,
    ) as CatalogProcessor["run"],
    close: vi.fn(),
    onFailure: (handler) => {
      failed = handler;
    },
  };
  const loadSeed = vi.fn(
    async (
      append: (entries: JavbusCatalogEntry[], reset: boolean, done: boolean) => Promise<unknown>,
    ) => {
      await append(seed.javbusEntries, true, true);
    },
  );
  const write = vi.fn();
  const service = new DiscoveryCatalogService(processor, {
    loadSeed,
    ensureSeed: vi.fn(),
    read: async () => {
      throw new Error("safe cache read failure");
    },
    readCsv: async () => ({}),
    write,
    fetch: vi.fn(),
  });
  try {
    await service.ready();
    failed();
    expect(service.getSnapshot().ready).toBe(false);
    await service.initialize();
    expect(loadSeed).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().ready).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(service.getSnapshot().warning).toContain("缓存读取失败");
  } finally {
    await service.shutdown();
  }
});

it("SQLite 迁移丢弃旧全量演员 names 与普通未知记录，保留数量和人工别名", () => {
  const legacyEntries = [
    entry("known", 0),
    entry("missing"),
    entry("counted", 8),
    { ...entry("manual"), aliases: ["安全手动别名"] },
  ];
  const old = loadDiscovery({ ...seed, javbusEntries: legacyEntries }, null, now);
  const cache = JSON.parse(old.cache);
  cache.version = 7;
  cache.javbusEntries = legacyEntries;
  cache.javbusCountUpdates = [["actresses", "censored", "removed-id", 20, now]];
  cache.javbusOrderSize = { censored: 500, uncensored: 0 };
  const migrated = loadDiscovery(seed, JSON.stringify(cache), now);
  expect(migrated.catalogs.actresses.names).toEqual([
    "安全演员known",
    "安全演员counted",
    "安全演员manual",
  ]);
  expect(migrated.catalogs.actresses.videoCounts?.["安全演员known"]).toBe(0);
  expect(retainLegacyJavbusEntries(legacyEntries, seed.javbusEntries).map((v) => v.id)).toEqual([
    "known",
    "counted",
    "manual",
  ]);
  expect(JSON.parse(migrated.cache).version).toBe(8);
  expect(loadDiscovery(seed, migrated.cache, now).catalogs.actresses.names).toEqual(
    migrated.catalogs.actresses.names,
  );
});

it("SQLite 目录仅同步新增和变化的覆盖，不重复导入内置记录", () => {
  const baseline = loadDiscovery(seed, null, now);
  expect(nativeCatalogOverrides(baseline, baseline).actresses.names).toEqual([]);
  const current = loadDiscovery(
    { ...seed, javbusEntries: [entry("known", 5), entry("new", 2)] },
    null,
    now,
  );
  const delta = nativeCatalogOverrides(baseline, current).actresses;
  expect(delta.names).toEqual(["安全演员known", "安全演员new"]);
  expect(delta.positions).toEqual([0, 1]);
  expect(delta.videoCounts).toEqual({ 安全演员known: 5, 安全演员new: 2 });
});

it("SQLite 名录未收录的演员仍独立在线查询两个分区（mock）", async () => {
  const fetch = vi.fn(async () => "safe mock response");
  const processor = {
    run: vi.fn(async () => ({
      items: [
        {
          id: "safe-online",
          name: "安全未收录演员",
          url: "https://safe.example.invalid/star/safe-online",
        },
      ],
      nextPage: null,
    })),
    close: vi.fn(),
  };
  const search = new OnlineActorSearchService(processor as unknown as CatalogProcessor, fetch);
  try {
    search.search("安全未收录演员");
    await vi.waitFor(() => expect(search.getSnapshot().loading).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(search.getSnapshot().items.map((v) => v.name)).toEqual(["安全未收录演员"]);
  } finally {
    await search.shutdown();
  }
});
