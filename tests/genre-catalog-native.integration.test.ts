import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type { FacetValue, QueryPage } from "../frontend/src/contracts/library";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("分类目录与原生片库合并分页", () => {
  let host: MediaHost;
  let root: string;
  beforeAll(async () => {
    const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
    await fs.mkdir(temp, { recursive: true });
    root = await fs.mkdtemp(path.join(temp, "genre-catalog-"));
    const seed = new MediaHost();
    try {
      await seed.start(path.join(root, "downloads.sqlite3"));
      await seed.request("library.status");
    } finally {
      await seed.close();
    }
    const database = new DatabaseSync(path.join(root, "library.sqlite3"));
    try {
      database.exec(
        "INSERT INTO entities(id,kind,name) VALUES(1,'genres','已有分类'),(2,'genres','自定义分类'); INSERT INTO works(id,title) VALUES('sample','合成作品'); INSERT INTO work_entities(work_id,entity_id) VALUES('sample',1),('sample',2)",
      );
    } finally {
      database.close();
    }
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    await host.request("library.status");
  });
  afterAll(async () => {
    await host?.close();
  });
  const query = (params: object = {}) =>
    host.request<QueryPage<FacetValue>>("library.facets", {
      dimension: "genres",
      catalogNames: ["已有分类", "内置分类", "已有分类"],
      ...params,
    });
  it("保留本地独有项，去重不放大影片数量，零影片分类可翻页", async () => {
    const result = await query({ sort: "name", limit: 1 });
    expect(result.total).toBe(3);
    expect(result.available).toBe(3);
    expect(result.items).toEqual([{ name: "内置分类", count: 0 }]);
    const tail = await query({ sort: "name", offset: 2, limit: 1, includeTotal: false });
    expect(tail.items).toEqual([{ name: "自定义分类", count: 1 }]);
    const local = await host.request<QueryPage<FacetValue>>("library.facets", {
      dimension: "genres",
    });
    expect(local.total).toBe(2);
  });
  it("合并结果按搜索与收藏筛选，其他维度拒绝混入目录", async () => {
    const searched = await query({ query: "内置" });
    expect(searched.total).toBe(1);
    expect(searched.available).toBe(3);
    expect(searched.items[0]?.count).toBe(0);
    expect((await query({ names: [] })).total).toBe(0);
    expect((await query({ names: ["自定义分类"] })).items).toEqual([
      { name: "自定义分类", count: 1 },
    ]);
    await expect(query({ dimension: "actors" })).rejects.toThrow("目录参数");
  });
});
