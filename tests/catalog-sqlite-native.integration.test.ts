import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import { MediaHost } from "./helpers/mediaHost";
import { safeCatalogSeed } from "./helpers/catalogSeed";
import type { JavbusCatalogEntry } from "../frontend/src/services/catalog/javbusCatalog";
import type { FacetValue, QueryPage } from "../frontend/src/contracts/library";

describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "精简 SQLite 原生目录（仅安全样例）",
  () => {
    let host: MediaHost;
    let directory: string;
    let fixture: Awaited<ReturnType<typeof safeCatalogSeed>>;
    let seedHash: string;
    const hash = async () =>
      createHash("sha256")
        .update(await fs.readFile(fixture.filename))
        .digest("hex");
    beforeAll(async () => {
      await fs.mkdir(path.resolve(".tmp"), { recursive: true });
      directory = await fs.mkdtemp(path.resolve(".tmp/catalog-sqlite-"));
      fixture = await safeCatalogSeed(path.join(directory, "中文目录 # % seed"));
      seedHash = await hash();
      host = new MediaHost();
      await host.start(path.join(directory, "downloads.sqlite3"));
      await host.request("library.status");
    }, 30000);
    afterAll(async () => {
      await host?.close();
    });

    it("拒绝错误格式后可以重试，预建索引分页不需要 catalogAppend，零数量保留", async () => {
      const invalid = path.join(directory, "invalid.sqlite3");
      const wrong = new DatabaseSync(invalid);
      wrong.exec("CREATE TABLE safe(value)");
      wrong.close();
      await expect(host.request("library.catalogSeed", { path: invalid })).rejects.toThrow(
        "版本无效",
      );
      await host.request("library.catalogSeed", { path: fixture.filename });
      const first = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actresses",
        includeCatalog: true,
        includeVideoCounts: true,
        sort: "source",
        limit: 100,
      });
      expect(first.total).toBe(125);
      expect(first.items).toHaveLength(100);
      expect(first.items[0]).toMatchObject({ name: "安全演员0", videoCount: 0, count: 0 });
      expect(first.items[1]?.videoCount).toBe(11);
      expect(first.items[2]?.videoCount).toBeNull();
      const last = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actresses",
        includeCatalog: true,
        sort: "source",
        offset: 100,
        limit: 100,
      });
      expect(last.items.map((v) => v.name)).toEqual(
        Array.from({ length: 25 }, (_, i) => `安全演员${i + 100}`),
      );
      const records = await host.request<{ items: JavbusCatalogEntry[]; done: boolean }>(
        "library.catalogEntries",
        { limit: 500 },
      );
      expect(records.done).toBe(true);
      expect(records.items).toEqual(fixture.entries);
      const firstBatch = await host.request<{
        items: JavbusCatalogEntry[];
        after: number;
        done: boolean;
      }>("library.catalogEntries", { limit: 3 });
      const nextBatch = await host.request<{ items: JavbusCatalogEntry[] }>(
        "library.catalogEntries",
        { limit: 3, after: firstBatch.after },
      );
      expect(firstBatch.after).toBe(3);
      expect(firstBatch.done).toBe(false);
      expect([...firstBatch.items, ...nextBatch.items]).toEqual(fixture.entries.slice(0, 6));
      expect(await hash()).toBe(seedHash);
    });

    it("增量覆盖与清理不改变内置库，未知演员的已有收藏继续可见", async () => {
      await host.request("library.catalogSeed", { path: fixture.filename });
      await host.request("library.catalogAppend", {
        dimension: "actresses",
        offset: 0,
        reset: true,
        names: ["安全演员0", "安全新增演员"],
        videoCounts: [45, 4],
        positions: [0, 125],
      });
      let page = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actresses",
        includeCatalog: true,
        includeVideoCounts: true,
        sort: "source",
      });
      expect(page.total).toBe(126);
      expect(page.items[0]?.videoCount).toBe(45);
      await host.request("library.catalogAppend", {
        dimension: "actresses",
        offset: 0,
        reset: true,
        names: [],
        videoCounts: [],
        positions: [],
      });
      await host.request("library.facetFavorite", {
        dimension: "actresses",
        name: "安全未知演员",
        value: true,
      });
      page = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actresses",
        includeCatalog: true,
        includeFavorites: true,
        favoritesOnly: true,
      });
      expect(page.items).toEqual([{ name: "安全未知演员", count: 0, favorite: 1 }]);
      expect(await hash()).toBe(seedHash);
      await host.close();
      host = new MediaHost();
      await host.start(path.join(directory, "downloads.sqlite3"));
      await host.request("library.catalogSeed", { path: fixture.filename });
      page = await host.request<QueryPage<FacetValue>>("library.facets", {
        dimension: "actresses",
        includeCatalog: true,
        includeVideoCounts: true,
        sort: "source",
      });
      expect(page.total).toBe(126);
      expect(page.items[0]?.videoCount).toBe(0);
    });
  },
);
