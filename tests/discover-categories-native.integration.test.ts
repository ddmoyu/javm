import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import type { FacetValue, NativeVideo, QueryPage } from "../frontend/src/contracts/library";

describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "男女演员原生目录隔离",
  () => {
    let host: MediaHost;
    beforeAll(async () => {
      const base = path.resolve(".tmp");
      await fs.mkdir(base, { recursive: true });
      const root = await fs.mkdtemp(path.join(base, "discover-categories-"));
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
          "INSERT INTO works(id,title) VALUES('safe-example','安全合成作品'); INSERT INTO entities(id,kind,name) VALUES(1,'actors','合成女演员'),(2,'actors','合成男演员'),(3,'actors','未分类合成人员'); INSERT INTO work_entities(work_id,entity_id) VALUES('safe-example',1),('safe-example',2),('safe-example',3)",
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
    it("发现目录仅列匹配名单的演员，本地作品数及点击筛选正确，未分类人员保留在普通筛选", async () => {
      await host.request("library.catalogAppend", {
        dimension: "actresses",
        names: ["合成女演员", "合成新女演员"],
      });
      await host.request("library.catalogAppend", {
        dimension: "maleActors",
        names: ["合成男演员"],
      });
      const female = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actresses",
        includeCatalog: true,
        sort: "source",
      });
      expect(female.items).toEqual([
        { name: "合成女演员", count: 1 },
        { name: "合成新女演员", count: 0 },
      ]);
      const male = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "maleActors",
        includeCatalog: true,
      });
      expect(male.items).toEqual([{ name: "合成男演员", count: 1 }]);
      const unclassified = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actors",
        query: "未分类",
      });
      expect(unclassified.items).toEqual([{ name: "未分类合成人员", count: 1 }]);
      const works = await host.request<QueryPage<NativeVideo>>("library.query", {
        facet: { dimension: "maleActors", value: "合成男演员" },
      });
      expect(works.total).toBe(1);
      const mismatch = await host.request<QueryPage<NativeVideo>>("library.query", {
        facet: { dimension: "actresses", value: "合成男演员" },
      });
      expect(mismatch.total).toBe(0);
    });
  },
);
