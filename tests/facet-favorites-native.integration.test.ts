import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import type { FacetValue, QueryPage } from "../frontend/src/contracts/library";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("发现收藏持久化（安全虚构数据）", () => {
  let host: MediaHost;
  let database: string;
  const start = async () => {
    host = new MediaHost();
    await host.start(database);
    await host.request("library.status");
    for (const dimension of ["actresses", "directors"])
      await host.request("library.catalogAppend", { dimension, names: ["虚构甲", "虚构乙"] });
  };
  const query = (dimension: string, favoritesOnly = false) =>
    host.request<QueryPage<FacetValue>>("library.facets", {
      dimension,
      includeCatalog: true,
      includeFavorites: true,
      favoritesOnly,
      sort: "name",
    });
  beforeAll(async () => {
    await fs.mkdir(".tmp", { recursive: true });
    database = path.resolve(await fs.mkdtemp(".tmp/facet-favorites-"), "downloads.sqlite3");
    await start();
  });
  afterAll(async () => {
    await host?.close();
  });
  it("重启后仍可分页筛选收藏，同名不同维度保持独立", async () => {
    await host.request("library.facetFavorite", {
      dimension: "actresses",
      name: "虚构甲",
      value: true,
    });
    await host.close();
    await start();
    const result = await query("actresses", true);
    expect(result.total).toBe(1);
    expect(result.items).toEqual([{ name: "虚构甲", count: 0, favorite: 1 }]);
    expect((await query("directors", true)).total).toBe(0);
  });
  it("取消收藏更新筛选计数，拒绝无效请求且保留其他记录", async () => {
    await host.request("library.facetFavorite", {
      dimension: "directors",
      name: "虚构乙",
      value: true,
    });
    await host.request("library.facetFavorite", {
      dimension: "actresses",
      name: "虚构甲",
      value: false,
    });
    expect((await query("actresses", true)).total).toBe(0);
    await expect(
      host.request("library.facetFavorite", { dimension: "actresses", name: "", value: true }),
    ).rejects.toThrow();
    expect((await query("directors", true)).items[0]?.name).toBe("虚构乙");
  });
});
