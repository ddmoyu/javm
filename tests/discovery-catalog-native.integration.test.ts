import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import { catalogDimensions } from "../frontend/src/services/catalog/discoveryData";
import type { FacetValue, NativeVideo, QueryPage } from "../frontend/src/contracts/library";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("六类名单原生分页和发行商", () => {
  let host: MediaHost;
  beforeAll(async () => {
    const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
    await fs.mkdir(temp, { recursive: true });
    const root = await fs.mkdtemp(path.join(temp, "discovery-catalog-"));
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
        "INSERT INTO works(id,title,studio,director,label,series) VALUES('sample','合成作品','本地studios','本地directors','本地labels','本地series'); INSERT INTO entities(id,kind,name) VALUES(1,'actors','本地actors'),(2,'genres','本地genres'); INSERT INTO work_entities(work_id,entity_id) VALUES('sample',1),('sample',2)",
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
  it("六类独立合并、去重和计数，内置名称不写入影片关系", async () => {
    for (const dimension of catalogDimensions.filter(
      (value) => value !== "actresses" && value !== "maleActors",
    )) {
      await host.request("library.catalogAppend", {
        dimension,
        names: [`本地${dimension}`, `远端${dimension}`, `远端${dimension}`],
      });
      const result = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension,
        includeCatalog: true,
        sort: "count",
      });
      expect(result.total).toBe(2);
      expect(result.items).toEqual([
        { name: `本地${dimension}`, count: 1 },
        { name: `远端${dimension}`, count: 0 },
      ]);
      const local = await host.request<QueryPage<FacetValue>>("library.facets", { dimension });
      expect(local.total).toBe(1);
    }
    await expect(
      host.request("library.catalogAppend", { dimension: "years", names: ["2026"] }),
    ).rejects.toThrow("参数无效");
    await expect(
      host.request("library.catalogAppend", {
        dimension: "labels",
        names: Array(501).fill("合成"),
      }),
    ).rejects.toThrow("参数无效");
  });
  it("超过旧版五千项上限仍按页查询，深页、搜索、收藏保持一致", async () => {
    for (let offset = 0; offset < 35000; offset += 500)
      await host.request("library.catalogAppend", {
        dimension: "actors",
        names: Array.from(
          { length: 500 },
          (_, n) => `合成员${String(offset + n).padStart(5, "0")}`,
        ),
      });
    const result = await host.request<QueryPage<FacetValue>>("library.facets", {
      dimension: "actors",
      includeCatalog: true,
      query: "合成员",
      offset: 34950,
      limit: 50,
      sort: "name",
    });
    expect(result.total).toBe(35000);
    expect(result.items).toHaveLength(50);
    expect(result.items[49]).toEqual({ name: "合成员34999", count: 0 });
    const selected = await host.request<QueryPage<FacetValue>>("library.facets", {
      dimension: "actors",
      includeCatalog: true,
      names: ["合成员34999"],
    });
    expect(selected.total).toBe(1);
  });
  it("发行商编辑、详情及作品筛选独立于制作商", async () => {
    await host.request("library.updateMetadata", {
      id: "sample",
      patch: { label: "修改发行商" },
      expected: { label: "本地labels" },
    });
    const video = await host.request<NativeVideo>("library.video", { id: "sample" });
    expect(video.label).toBe("修改发行商");
    expect(video.studio).toBe("本地studios");
    const works = await host.request<QueryPage<NativeVideo>>("library.query", {
      facet: { dimension: "labels", value: "修改发行商" },
    });
    expect(works.total).toBe(1);
    const wrong = await host.request<QueryPage<NativeVideo>>("library.query", {
      facet: { dimension: "studios", value: "修改发行商" },
    });
    expect(wrong.total).toBe(0);
  });
});
