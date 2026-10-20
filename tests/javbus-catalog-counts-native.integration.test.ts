import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type { FacetValue, QueryPage } from "../frontend/src/contracts/library";

describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "JavBus 数量安全原生查询",
  () => {
    let host: MediaHost;
    const names = [
      "安全本地多但网站未知",
      "安全网站零",
      "Z安全网站十",
      "A安全网站十",
      "安全网站百",
    ];
    beforeAll(async () => {
      const base = path.resolve(import.meta.dirname, "../.tmp/");
      await fs.mkdir(base, { recursive: true });
      const root = await fs.mkdtemp(path.join(base, "javbus-count-safe-"));
      const initial = new MediaHost();
      try {
        await initial.start(path.join(root, "downloads.sqlite3"));
        await initial.request("library.status");
      } finally {
        await initial.close();
      }
      const database = new DatabaseSync(path.join(root, "library.sqlite3"));
      try {
        const insert = database.prepare("INSERT INTO works(id,title,studio) VALUES(?,?,?)");
        for (let index = 0; index < 8; index++)
          insert.run(`safe-${index}`, `安全虚构示例${index}`, names[0]!);
        insert.run("safe-one", "安全虚构单项", names[4]!);
      } finally {
        database.close();
      }
      host = new MediaHost();
      await host.start(path.join(root, "downloads.sqlite3"));
      await host.request("library.status");
      await host.request("library.catalogAppend", {
        dimension: "studios",
        offset: 0,
        names,
        videoCounts: [null, 0, 10, 10, 100],
      });
    });
    afterAll(async () => {
      await host?.close();
    });
    const query = (params: object = {}) =>
      host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "studios",
        includeCatalog: true,
        includeVideoCounts: true,
        sort: "videoCount",
        ...params,
      });
    it("按网站数量在 SQL 分页前降序，本地收录数不参与排序，未知与零独立", async () => {
      const result = await query();
      expect(result.items).toEqual([
        { name: names[4], count: 1, videoCount: 100 },
        { name: names[2], count: 0, videoCount: 10 },
        { name: names[3], count: 0, videoCount: 10 },
        { name: names[1], count: 0, videoCount: 0 },
        { name: names[0], count: 8, videoCount: null },
      ]);
      expect((await query({ offset: 1, limit: 2 })).items).toEqual(result.items.slice(1, 3));
      expect((await query({ sort: "source" })).items.map((item) => item.name)).toEqual(names);
      expect((await query({ names: [names[1], names[4]] })).items.map((item) => item.name)).toEqual(
        [names[4], names[1]],
      );
      await host.request("library.facetFavorite", {
        dimension: "studios",
        name: names[4],
        value: true,
      });
      expect((await query({ favoritesOnly: true })).items.map((item) => item.name)).toEqual([
        names[4],
      ]);
    });
    it("同一名单只更新数量也会改变排序，无效数量被拒绝且已有数据保留", async () => {
      for (const videoCounts of [
        [-1, 0, 10, 10, 100],
        [null, 0.5, 10, 10, 100],
        [1],
        [null, 0, 10, 10, 100000001],
      ])
        await expect(
          host.request("library.catalogAppend", {
            dimension: "studios",
            offset: 0,
            names,
            videoCounts,
          }),
        ).rejects.toThrow("数量");
      expect((await query()).items[0]?.videoCount).toBe(100);
      await host.request("library.catalogAppend", {
        dimension: "studios",
        offset: 0,
        names,
        videoCounts: [null, 0, 300, 10, 100],
      });
      expect((await query()).items[0]).toMatchObject({ name: names[2], videoCount: 300 });
      expect((await query({ sort: "source" })).items.map((item) => item.name)).toEqual(names);
      await expect(query({ sort: "count" })).rejects.toThrow("未知维度排序方式");
      await host.request("library.catalogAppend", {
        dimension: "labels",
        offset: 0,
        names: ["安全重复发行商", "安全重复发行商"],
        videoCounts: [null, 10],
      });
      expect((await query({ dimension: "labels" })).items).toEqual([
        { name: "安全重复发行商", count: 0, videoCount: null },
      ]);
    });
    it("别名合并后的多个身份不虚构网站总数，本地计数和来源位置保持可用", async () => {
      await host.request("library.catalogAppend", {
        dimension: "directors",
        offset: 0,
        names: ["安全导演甲", "安全导演别名", "安全导演乙"],
        videoCounts: [10, 20, 0],
      });
      await host.request("library.aliases.save", {
        dimension: "directors",
        alias: "安全导演别名",
        canonical: "安全导演甲",
        label: "安全导演校对名称",
      });
      const result = await query({ dimension: "directors" });
      expect(result.items).toEqual([
        { name: "安全导演乙", count: 0, videoCount: 0 },
        { name: "安全导演甲", count: 0, videoCount: null },
      ]);
      expect(
        (await query({ dimension: "directors", sort: "source" })).items.map((item) => item.name),
      ).toEqual(["安全导演甲", "安全导演乙"]);
    });
    it("跨五百项批次数量仍与名称对齐，支持数量排序后的深分页", async () => {
      const entries = Array.from({ length: 503 }, (_, n) => `安全系列${n}`);
      for (let offset = 0; offset < entries.length; offset += 500)
        await host.request("library.catalogAppend", {
          dimension: "series",
          offset,
          names: entries.slice(offset, offset + 500),
          videoCounts: entries.slice(offset, offset + 500).map((_, n) => offset + n),
        });
      expect(
        (await query({ dimension: "series", offset: 499, limit: 4 })).items.map((item) => [
          item.name,
          item.videoCount,
        ]),
      ).toEqual([
        [entries[3], 3],
        [entries[2], 2],
        [entries[1], 1],
        [entries[0], 0],
      ]);
    });
  },
);
