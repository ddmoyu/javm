import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import type { DiscoveryCatalogPort } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import {
  catalogDimensions,
  loadDiscovery,
  mergeDiscovery,
  parseEntities,
  parseListing,
} from "../frontend/src/services/catalog/discoveryData";
import type { DiscoverySeed } from "../frontend/src/services/catalog/discoveryData";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";
import { loadCatalog, queryCatalog } from "../frontend/src/services/catalog/catalogData";
import { LibraryService } from "../frontend/src/services/library/LibraryService";

const seed: DiscoverySeed = {
  genres: [{ lane: "censored", id: "a", name: "中文分类", category: "类型" }],
  actors: ["合成演员"],
  javbusEntries: (["actresses", "maleActors"] as const).map((dimension) => ({
    dimension,
    lane: "censored" as const,
    id: `safe-${dimension}`,
    name: dimension === "actresses" ? "合成女演员" : "合成男演员",
    label: dimension === "actresses" ? "合成女演员" : "合成男演员",
    aliases: [],
    translationStatus: "pending" as const,
    category: "",
  })),
  entities: ["studios", "labels", "series", "directors"].map((dimension) => ({
    dimension,
    name: `合成${dimension}`,
  })),
};
const first = { offset: 0, limit: 50, includeTotal: true };
const listing = `<div>${Array.from({ length: 10 }, (_, n) => `<a class="movie-box" href="/SAMPLE-${n}">合成条目</a>`).join("")}<a id="next" href="/page/2">下一页</a></div>`;
const detail =
  '<div class="col-md-3 info"><a href="/studio/s1">新增制作商</a><a href="/label/l1">新增发行商</a><a href="/series/r1">新增系列</a><a href="/director/d1">新增导演</a><a href="/star/a1">新增演员</a></div>';
const services: DiscoveryCatalogService[] = [];
function processor(): CatalogProcessor {
  const run = async (
    operation: CatalogRequest["operation"],
    payload: CatalogRequest["payload"],
  ) => {
    const task = { id: 0, operation, payload } as CatalogRequest;
    switch (task.operation) {
      case "discoveryLoad":
        return loadDiscovery(seed, task.payload.cache, Date.now());
      case "discoveryMerge":
        return mergeDiscovery(seed, task.payload.cache, task.payload.update, Date.now());
      case "listing":
        return parseListing(task.payload.html, task.payload.lane);
      case "entities":
        return parseEntities(task.payload.html);
      case "query":
        return queryCatalog(task.payload.names, task.payload.query, task.payload.page);
    }
  };
  return { run: run as CatalogProcessor["run"], close: vi.fn() };
}
function service(overrides: Partial<DiscoveryCatalogPort> = {}) {
  const port = {
    read: vi.fn(async () => null as string | null),
    write: vi.fn(async (_cache: string) => {}),
    fetch: vi.fn(async (url: string, _signal: AbortSignal) =>
      url.endsWith(".com/") ? listing : detail,
    ),
    ...overrides,
  };
  const catalog = new DiscoveryCatalogService(processor(), port);
  services.push(catalog);
  return { catalog, port };
}
afterEach(async () => {
  for (const catalog of services.splice(0)) await catalog.shutdown();
  vi.useRealTimers();
});
describe("六类发现名单", () => {
  it("缓存及媒体库未就绪时六类均可离线分页，普通筛选不混入目录", async () => {
    vi.useFakeTimers();
    let release!: (value: null) => void;
    const { catalog } = service({
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const loading = catalog.initialize();
    await catalog.ready();
    const library = new LibraryService(undefined, catalog);
    for (const dimension of catalogDimensions) {
      const view = library.createFacetQuery(true);
      view.configure({ dimension }, true);
      await vi.waitFor(() => expect(view.getSnapshot().ready).toBe(true));
      expect(view.getSnapshot().total).toBe(1);
      expect(view.getSnapshot().items.get(0)?.count).toBe(0);
    }
    const local = library.createFacetQuery();
    local.configure({ dimension: "labels" }, true);
    await vi.waitFor(() => expect(local.getSnapshot().ready).toBe(true));
    expect(local.getSnapshot().total).toBe(0);
    release(null);
    await loading;
    await library.shutdown();
  });
  it("旧版分类缓存迁移保留名称，其他五类同时补入；损坏缓存拒绝覆盖", () => {
    const old = loadCatalog(seed.genres, null, Date.now());
    const data = loadDiscovery(seed, old.cache, Date.now());
    for (const dimension of catalogDimensions)
      expect(data.catalogs[dimension].names).toHaveLength(1);
    const invalid = JSON.parse(data.cache);
    invalid.cursors.censored.page = "https://example.com";
    expect(() => loadDiscovery(seed, JSON.stringify(invalid), Date.now())).toThrow("缓存无效");
  });
  it("302 与无效页面保留六类快照，错误不泄露网页正文", async () => {
    vi.useFakeTimers();
    const { catalog, port } = service({
      read: async () => "broken",
      fetch: async () => {
        throw new Error("HTTP 302");
      },
    });
    await catalog.initialize();
    const before = catalog.getSnapshot().catalogs;
    await catalog.refresh("genres");
    expect(catalog.getSnapshot().catalogs).toBe(before);
    expect(catalog.getSnapshot().errors.genres).toContain("302");
    expect(port.write).not.toHaveBeenCalled();
    expect(() => parseEntities('<form action="/verify">private payload</form>')).toThrow(
      "有效资料",
    );
    expect(() => parseListing('<form action="/verify">private payload</form>', "censored")).toThrow(
      "有效目录",
    );
  });
  it("实体刷新保留已有资料与游标，不遍历作品或演员目录", async () => {
    vi.useFakeTimers();
    const { catalog, port } = service();
    const updating = catalog.refresh("studios");
    expect(catalog.refresh("labels")).toBe(updating);
    await updating;
    expect(port.fetch).not.toHaveBeenCalled();
    expect(catalog.getSnapshot().catalogs.labels.names).toEqual(["合成labels"]);
    expect(catalog.getSnapshot().catalogs.studios.names).not.toContain("新增发行商");
    const cache = vi.mocked(port.write).mock.calls[0]![0];
    const saved = loadDiscovery(seed, cache, Date.now());
    expect(saved.cursors).toEqual(loadDiscovery(seed, null, Date.now()).cursors);
    expect(saved.lane).toBe("censored");
    expect(saved.catalogs.genres.names).toEqual(["中文分类"]);
  });
  it("取消分类更新不保存半份名单或推进游标，其他更新不会并发启动", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { catalog, port } = service({
      fetch: (_url, signal) =>
        new Promise((_, reject) => {
          started();
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
    });
    const pending = catalog.refresh("genres");
    await fetching;
    expect(catalog.refresh("labels")).toBe(pending);
    catalog.cancel();
    await pending;
    expect(catalog.getSnapshot().updating).toBeNull();
    expect(catalog.getSnapshot().errors.genres).toBe("");
    expect(port.write).not.toHaveBeenCalled();
    expect(catalog.getSnapshot().catalogs.directors.names).toHaveLength(1);
  });
  it("保存失败仍可分页查询本次合并内容，并提示未持久化", async () => {
    vi.useFakeTimers();
    const { catalog } = service({
      fetch: async (url) => {
        const prefix = url.includes("/uncensored/") ? "/uncensored" : "";
        return (
          '<div class="genre-box">' +
          Array.from(
            { length: 50 },
            (_, index) =>
              '<a href="' +
              prefix +
              "/genre/" +
              (index === 0 ? "a" : "safe-" + index) +
              '">' +
              (index === 0 ? "新增安全分类" : "合成分类" + index) +
              "</a>",
          ).join("") +
          "</div>"
        );
      },
      write: async () => {
        throw new Error("disk failure");
      },
    });
    await catalog.refresh("genres");
    expect(catalog.getSnapshot().warning).toContain("保存失败");
    expect(
      (await catalog.query({ dimension: "genres", names: ["新增安全分类"] }, first)).items,
    ).toEqual([{ name: "新增安全分类", count: 0 }]);
  });
  it("拒绝站外分页及脚本伪造链接，保留中文与专有名词", () => {
    const data = parseEntities(
      detail +
        '<script><a href="/label/fake">伪造</a></script><a href="https://example.com/label/fake">站外</a>',
    );
    expect(data.labels).toEqual(["新增发行商"]);
    expect(
      parseListing(listing.replace("/page/2", "https://example.com/page/2"), "censored").page,
    ).toBe("/");
  });
});
