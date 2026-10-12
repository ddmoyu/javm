import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  categoryForFacet,
  discoverCategories,
} from "../frontend/src/features/discover/discoverCategories";
import { facetNames } from "../frontend/src/features/films/filmMetadata";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import {
  loadDiscovery,
  mergeDiscovery,
  parseActorDirectory,
} from "../frontend/src/services/catalog/discoveryData";
import type { DiscoverySeed } from "../frontend/src/services/catalog/discoveryData";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";
import { queryCatalog } from "../frontend/src/services/catalog/catalogData";

const seed: DiscoverySeed = {
  actors: ["未分类合成人员"],
  genres: [],
  entities: [{ dimension: "studios", name: "合成制作商" }],
  actorDirectories: { actresses: ["合成女演员"], maleActors: ["合成男演员"] },
};
afterEach(() => vi.useRealTimers());

describe("发现分类", () => {
  it("显示已接入的发现维度，未知及冲突的演员不猜测目录，原元数据字段仍可浏览", () => {
    const { catalogs } = loadDiscovery(seed, null, Date.now());
    expect(discoverCategories).toEqual(["女演员", "男演员", "制作商", "发行商", "分类"]);
    expect(categoryForFacet("演员", "合成女演员", catalogs)).toBe("女演员");
    expect(categoryForFacet("演员", "合成男演员", catalogs)).toBe("男演员");
    expect(categoryForFacet("演员", "未分类合成人员", catalogs)).toBeUndefined();
    catalogs.maleActors.names.push("合成女演员");
    expect(categoryForFacet("演员", "合成女演员", catalogs)).toBeUndefined();
    expect(categoryForFacet("发行商", "合成发行商", catalogs)).toBe("发行商");
    expect(categoryForFacet("分类", "安全示例分类", catalogs)).toBe("分类");
    expect(facetNames).toContain("发行商");
    expect(facetNames).toContain("分类");
  });
  it("旧 GFriends 名单不进入新男女目录，其他名单迁移，验证页和错误分区被拒绝", () => {
    const old = JSON.parse(loadDiscovery(seed, null, Date.now()).cache);
    old.version = 2;
    old.catalogs.actors.names = ["旧来源合成人员"];
    old.catalogs.studios.names.push("旧缓存合成制作商");
    delete old.catalogs.actresses;
    delete old.catalogs.maleActors;
    delete old.actorPages;
    const current = loadDiscovery(seed, JSON.stringify(old), Date.now());
    expect(current.catalogs.actresses.names).toEqual(["合成女演员"]);
    expect(current.catalogs.maleActors.names).toEqual(["合成男演员"]);
    expect(current.catalogs.actors.names).not.toContain("旧来源合成人员");
    expect(current.catalogs.studios.names).toContain("旧缓存合成制作商");
    expect(() => parseActorDirectory("<form>合成验证页</form>", "actresses", 1)).toThrow();
    expect(() =>
      parseActorDirectory('<div>全 1 件</div><a href="/histrion/1/">合成人员</a>', "actresses", 1),
    ).toThrow();
    expect(() =>
      parseActorDirectory(
        '<div>全 101 件</div><a href="https://example.invalid/actor/1/">合成人员</a>',
        "actresses",
        1,
      ),
    ).toThrow();
  });
  it("男女目录分开更新，每批最多八页，分页位置恢复且不请求 GFriends", async () => {
    vi.useFakeTimers();
    const run = async (
      operation: CatalogRequest["operation"],
      payload: CatalogRequest["payload"],
    ) => {
      const task = { id: 0, operation, payload } as CatalogRequest;
      if (task.operation === "discoveryLoad")
        return loadDiscovery(seed, task.payload.cache, Date.now());
      if (task.operation === "discoveryMerge")
        return mergeDiscovery(seed, task.payload.cache, task.payload.update, Date.now());
      if (task.operation === "actorDirectory")
        return parseActorDirectory(task.payload.html, task.payload.dimension, task.payload.page);
      if (task.operation === "query")
        return queryCatalog(task.payload.names, task.payload.query, task.payload.page);
      throw new Error("不应请求其他来源");
    };
    const processor = { run: run as CatalogProcessor["run"], close() {} };
    const fetch = vi.fn(async (address: string) => {
      const url = new URL(address);
      expect(url.origin).toBe("https://avwikidb.com");
      if (url.pathname === "/histrion/")
        return '<div>全 1 件</div><a href="/histrion/1/">新增合成男演员</a>';
      const page = Number(url.searchParams.get("page") ?? 1);
      return `<div>全 1000 件</div>${Array.from({ length: 100 }, (_, n) => `<a href="/actor/${(page - 1) * 100 + n + 1}/">合成女演员${(page - 1) * 100 + n + 1}</a>`).join("")}<a href="/actor/?page=${page + 1}">下一页</a>`;
    });
    const write = vi.fn(async (_cache: string) => {});
    const catalog = new DiscoveryCatalogService(processor, {
      read: async () => null,
      write,
      fetch,
    });
    try {
      const pending = catalog.refresh("actresses");
      expect(catalog.refresh("maleActors")).toBe(pending);
      await pending;
      expect(fetch).toHaveBeenCalledTimes(8);
      expect(catalog.getSnapshot().catalogs.actresses.names).toHaveLength(801);
      expect(catalog.getSnapshot().catalogs.maleActors.names).toEqual(["合成男演员"]);
      expect(loadDiscovery(seed, write.mock.calls[0]![0], Date.now()).actorPages.actresses).toBe(9);
      await catalog.refresh("maleActors");
      expect(catalog.getSnapshot().catalogs.maleActors.names).toContain("新增合成男演员");
      expect(catalog.getSnapshot().catalogs.actresses.names).not.toContain("新增合成男演员");
    } finally {
      await catalog.shutdown();
    }
  });
});
