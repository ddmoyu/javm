import { beforeAll, afterAll, describe, it, expect } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("别名规则及旧收藏恢复（合成归档）", () => {
  let host: MediaHost;
  beforeAll(async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/entity-aliases-"));
    const source = path.join(root, "com.ddmoyu.javm", "javm.db");
    await fs.mkdir(path.dirname(source));
    const db = new DatabaseSync(source);
    db.exec(await fs.readFile("tests/fixtures/legacy-v2.sql", "utf8"));
    db.exec(`INSERT INTO videos(id,local_id,title,video_path,dir_path,studio) VALUES('safe-a','SAFE-001','安全样例甲','','','Studio Alias'),('safe-b','SAFE-002','安全样例乙','not-an-absolute-path','','Studio Main');
      INSERT INTO favorites(entity_type,name) VALUES('studio','Studio Alias');
      INSERT INTO entity_aliases(entity_type,entity_id,name,name_norm,is_canonical) VALUES('studio',7,'Studio Alias','a',0),('studio',7,'Studio Main','b',1);`);
    db.close();
    host = new MediaHost();
    await host.start(path.join(root, "JAVM", "downloads.sqlite3"));
    await host.request("library.legacy.check");
    await host.request("library.legacy.start");
    for (let n = 0; n < 100; n++) {
      const state = await host.request<{ state: string }>("library.legacy.status");
      if (state.state !== "running") {
        expect(state.state).toBe("completed");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  afterAll(async () => {
    await host?.close();
  });
  it("恢复收藏与规范分组幂等，按别名也能查询合并后的作品", async () => {
    expect(await host.request("library.aliases.restore")).toMatchObject({
      favorites: 1,
      aliases: 1,
    });
    expect(await host.request("library.aliases.restore")).toMatchObject({
      favorites: 0,
      aliases: 0,
    });
    const facets = await host.request<{
      items: { name: string; count: number; favorite: number }[];
    }>("library.facets", { dimension: "studios", includeFavorites: true });
    expect(facets.items).toEqual([{ name: "Studio Main", count: 2, favorite: 1 }]);
    const works = await host.request<{ total: number }>("library.query", {
      facet: { dimension: "studios", value: "Studio Alias" },
    });
    expect(works.total).toBe(2);
  });
  it("中文显示名可检索，循环合并会被拒绝", async () => {
    await host.request("library.aliases.save", {
      dimension: "studios",
      alias: "Studio Alias",
      canonical: "Studio Main",
      label: "虚构制作商",
    });
    const facets = await host.request<{ items: { label: string }[] }>("library.facets", {
      dimension: "studios",
      query: "虚构",
      includeLabels: true,
    });
    expect(facets.items[0]?.label).toBe("虚构制作商");
    await expect(
      host.request("library.aliases.save", {
        dimension: "studios",
        alias: "Studio Main",
        canonical: "Studio Alias",
      }),
    ).rejects.toThrow("循环");
  });
  it("屏蔽后恢复独立分组，旧数据恢复不会覆盖新规则或取消收藏", async () => {
    await host.request("library.aliases.save", {
      dimension: "studios",
      alias: "Studio Alias",
      canonical: "Studio Alias",
      blocked: true,
    });
    await host.request("library.facetFavorite", {
      dimension: "studios",
      name: "Studio Alias",
      value: false,
    });
    await host.request("library.aliases.restore");
    const facets = await host.request<{
      items: { name: string; count: number; favorite: number }[];
    }>("library.facets", { dimension: "studios", includeFavorites: true });
    expect(facets.items).toHaveLength(2);
    expect(facets.items.find((item) => item.name === "Studio Alias")).toMatchObject({
      count: 1,
      favorite: 0,
    });
  });
});
