import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type {
  FacetValue,
  LibraryStatus,
  NativeVideo,
  QueryPage,
} from "../frontend/src/contracts/library";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
describe.runIf(enabled)("五万条合成片库原生分页", () => {
  let host: MediaHost;
  let root: string;
  const timings: Record<string, number> = { records: 50000 };
  beforeAll(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/library-query-"));
    const seed = new MediaHost();
    try {
      await seed.start(path.join(root, "downloads-v1.sqlite3"));
      await seed.request("library.status");
    } finally {
      await seed.close();
    }
    const database = new DatabaseSync(path.join(root, "library.sqlite3"));
    try {
      database.exec("BEGIN");
      const actor = database.prepare("INSERT INTO entities(id,kind,name) VALUES(?,'actors',?)");
      for (let i = 1; i <= 1000; i++) actor.run(i, `演员${i}`);
      actor.run(1001, "配角独有");
      const genre = database.prepare("INSERT INTO entities(id,kind,name) VALUES(?,'genres',?)");
      for (let i = 1; i <= 20; i++) genre.run(2000 + i, `分类${i}`);
      genre.run(2021, "附加分类");
      const insert = database.prepare(
        "INSERT INTO works(id,code,code_key,title,runtime_seconds,premiered,scan_status,studio,director,created_at,series,provenance,favorite) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      const media = database.prepare(
        "INSERT INTO media_files(id,work_id,path,path_key,dir_path,file_size,width,height) VALUES(?,?,?,?,?,?,?,?)",
      );
      const relation = database.prepare(
        "INSERT INTO work_entities(work_id,entity_id,priority) VALUES(?,?,?)",
      );
      for (let i = 1; i <= 50000; i++) {
        const id = `video-${String(i).padStart(5, "0")}`;
        const file = path.join(root, `TEST-${i}.mp4`);
        insert.run(
          id,
          `TEST-${i}`,
          `test${i}`,
          i === 50000 ? "边界_%片名" : `合成影片 ${i}`,
          ((i % 4) + 1) * 1800,
          `${2020 + (i % 6)}-01-01`,
          i % 3 === 0 ? 2 : 0,
          `厂商${i % 4}`,
          `导演${i % 3}`,
          "2026-10-09 00:00:00",
          `系列${i % 8}`,
          JSON.stringify({ year: 2007 }),
          i % 10 === 0 ? 1 : 0,
        );
        media.run(
          id,
          id,
          file,
          file.replaceAll("\\", "/").toLowerCase(),
          root,
          [1, 4, 8, 12][i % 4]! * 1024 ** 3,
          i === 50000 ? 1920 : i % 2 ? 3840 : 1920,
          i === 50000 ? 1080 : i % 2 ? 2160 : 1080,
        );
        relation.run(id, (i % 1000) + 1, 0);
        relation.run(id, 2000 + (i % 20) + 1, 0);
      }
      relation.run("video-50000", 1001, 1);
      relation.run("video-50000", 2021, 0);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    host = new MediaHost();
    await host.start(path.join(root, "downloads-v1.sqlite3"));
    await host.request("library.status");
  }, 60000);
  afterAll(async () => {
    await host?.close();
    if (root)
      await fs.writeFile(path.join(root, "query-timings.json"), JSON.stringify(timings, null, 2));
  });
  const query = (params: object = {}) =>
    host.request<QueryPage<NativeVideo>>("library.query", params);

  it("首屏、末页和超范围有确定计数，上限一百条且分页不重复", async () => {
    const started = performance.now();
    const first = await query({ limit: 999 });
    const firstMs = performance.now() - started;
    const tailStart = performance.now();
    const last = await query({ offset: 49990, includeTotal: false });
    timings.firstPageMs = Math.round(firstMs);
    timings.lastPageMs = Math.round(performance.now() - tailStart);
    timings.firstPageBytes = Buffer.byteLength(JSON.stringify(first));
    console.log(
      JSON.stringify({
        records: 50000,
        firstPageMs: Math.round(firstMs),
        lastPageMs: Math.round(performance.now() - tailStart),
        firstPageBytes: Buffer.byteLength(JSON.stringify(first)),
      }),
    );
    expect(first.total).toBe(50000);
    expect(first.items).toHaveLength(100);
    expect(last.items).toHaveLength(10);
    expect(last.total).toBeUndefined();
    expect(first.items[0]?.id).toBe("video-00001");
    expect(last.items.at(-1)?.id).toBe("video-50000");
    expect((await query({ offset: 50000 })).items).toEqual([]);
    expect(await host.request("library.summary")).toEqual({ total: 50000, favorites: 5000 });
  });
  it("自然数字排序、中文搜索、字面通配符及次要演员查询", async () => {
    const started = performance.now();
    expect(
      (await query({ sort: "code", direction: "asc", limit: 3 })).items.map(
        (item) => item.local_id,
      ),
    ).toEqual(["TEST-1", "TEST-2", "TEST-3"]);
    console.log(
      JSON.stringify({ records: 50000, naturalSortMs: Math.round(performance.now() - started) }),
    );
    timings.naturalSortMs = Math.round(performance.now() - started);
    expect((await query({ query: "test-49999" })).total).toBe(1);
    expect((await query({ query: "_%" })).items.map((item) => item.id)).toEqual(["video-50000"]);
    expect((await query({ query: "配角独有" })).total).toBe(1);
    expect((await query({ query: "' OR 1=1 --" })).total).toBe(0);
  });
  it("演员、分类、年份、旧分辨率、时长与大小组合筛选一致", async () => {
    const result = await query({
      filters: {
        actors: ["配角独有"],
        genres: ["附加分类"],
        years: ["2022"],
        qualities: ["1080p"],
        duration: "short",
        size: "small",
        metadata: "missing",
      },
    });
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("video-50000");
    expect(result.items[0]?.actors).toContain("配角独有");
    expect((await query({ filters: { duration: "medium" } })).total).toBe(12500);
    expect((await query({ filters: { size: "medium" } })).total).toBe(12500);
  });
  it("发现维度统计和搜索分页不依赖前端已加载的影片", async () => {
    const facets = await host.request<QueryPage<FacetValue>>("library.facets", {
      dimension: "actors",
      query: "独有",
    });
    expect(facets).toMatchObject({
      total: 1,
      available: 1001,
      items: [{ name: "配角独有", count: 1 }],
    });
    expect(
      (
        await host.request<QueryPage<FacetValue>>("library.facets", {
          dimension: "actors",
          names: [],
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await host.request<QueryPage<FacetValue>>("library.facets", {
          dimension: "actors",
          offset: 1000,
        })
      ).items,
    ).toHaveLength(1);
    expect((await query({ facet: { dimension: "actors", value: "配角独有" } })).total).toBe(1);
    expect((await query({ facet: { dimension: "series", value: "系列0" } })).total).toBe(6250);
    expect((await query({ facet: { dimension: "studios", value: "厂商0" } })).total).toBe(12500);
  });
  it("收藏写入改变查询、计数、详情和修订号，番号查重排除自身", async () => {
    const before = await host.request<LibraryStatus>("library.status");
    await host.request("library.favorite", { id: "video-50000", value: false });
    expect((await host.request<LibraryStatus>("library.status")).revision).toBe(
      before.revision + 1,
    );
    expect((await query({ scope: "favorites" })).total).toBe(4999);
    expect((await host.request<NativeVideo>("library.video", { id: "video-50000" })).favorite).toBe(
      0,
    );
    expect(
      await host.request("library.duplicateCode", { code: "test-50000", except: "video-00001" }),
    ).toBe(true);
    expect(
      await host.request("library.duplicateCode", { code: "test-50000", except: "video-50000" }),
    ).toBe(false);
  });
  it("排序、维度白名单与筛选容量拒绝无效请求，数据库仍可读取", async () => {
    await expect(query({ sort: "title; DROP TABLE videos" })).rejects.toThrow("排序");
    await expect(host.request("library.facets", { dimension: "sqlite_master" })).rejects.toThrow(
      "维度",
    );
    await expect(
      query({ filters: { actors: Array.from({ length: 1001 }, () => "演员") } }),
    ).rejects.toThrow("筛选项");
    expect((await query()).total).toBe(50000);
  });
});
