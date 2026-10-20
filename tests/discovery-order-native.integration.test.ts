import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type { FacetValue, QueryPage } from "../frontend/src/contracts/library";

describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "发现目录来源顺序原生查询",
  () => {
    let host: MediaHost;
    beforeAll(async () => {
      const base = fileURLToPath(new URL("../.tmp/", import.meta.url));
      await fs.mkdir(base, { recursive: true });
      const root = await fs.mkdtemp(path.join(base, "discovery-order-"));
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
          "INSERT INTO works(id,title,studio) VALUES('sample-a','安全合成作品甲','A-示例靠后'),('sample-b','安全合成作品乙','本地独有示例')",
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
        dimension: "studios",
        includeCatalog: true,
        sort: "source",
        ...params,
      });

    it("来源顺序不受本地作品数影响，搜索、收藏、重排与别名归并保持正确位置", async () => {
      const names = ["Z-示例优先", "A-示例靠后", "#示例符号"];
      await host.request("library.catalogAppend", { dimension: "studios", offset: 0, names });
      const first = await query();
      expect(first.items).toEqual([
        { name: names[0], count: 0 },
        { name: names[1], count: 1 },
        { name: names[2], count: 0 },
        { name: "本地独有示例", count: 1 },
      ]);
      expect((await query({ query: "示例", offset: 1, limit: 1 })).items).toEqual([first.items[1]]);
      for (const name of [names[0], names[2]])
        await host.request("library.facetFavorite", { dimension: "studios", name, value: true });
      expect((await query({ favoritesOnly: true })).items.map((item) => item.name)).toEqual([
        names[0],
        names[2],
      ]);
      const reordered = [names[2], names[1], names[0]];
      await host.request("library.catalogAppend", {
        dimension: "studios",
        offset: 0,
        names: reordered,
      });
      expect((await query()).items.map((item) => item.name)).toEqual([
        ...reordered,
        "本地独有示例",
      ]);
      await host.request("library.aliases.save", {
        dimension: "studios",
        alias: names[2],
        canonical: names[0],
        label: "归并示例",
      });
      expect((await query()).items.map((item) => item.name)).toEqual([
        names[0],
        names[1],
        "本地独有示例",
      ]);
    });

    it("跨五百项导入边界和深页保留顺序，重复名称使用首次位置", async () => {
      const names = Array.from({ length: 502 }, (_, index) => `安全系列${502 - index}`);
      for (let offset = 0; offset < names.length; offset += 500)
        await host.request("library.catalogAppend", {
          dimension: "series",
          offset,
          names: names.slice(offset, offset + 500),
        });
      expect(
        (await query({ dimension: "series", offset: 499, limit: 3 })).items.map(
          (item) => item.name,
        ),
      ).toEqual(names.slice(499));
      await host.request("library.catalogAppend", {
        dimension: "directors",
        offset: 0,
        names: ["Z-示例导演", "A-示例导演", "Z-示例导演"],
      });
      expect((await query({ dimension: "directors" })).items.map((item) => item.name)).toEqual([
        "Z-示例导演",
        "A-示例导演",
      ]);
    });

    it("拒绝已移除的作品数量排序与无效顺序位置", async () => {
      await expect(query({ sort: "count" })).rejects.toThrow("未知维度排序方式");
      await expect(
        host.request("library.catalogAppend", {
          dimension: "studios",
          offset: -1,
          names: ["安全示例"],
        }),
      ).rejects.toThrow("名单顺序参数无效");
    });
  },
);
