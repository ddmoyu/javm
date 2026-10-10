import { describe, expect, it } from "vite-plus/test";
import {
  loadCatalog,
  parseGenrePage,
  queryCatalog,
  refreshCatalog,
} from "../frontend/src/services/catalog/catalogData";
import type { GenreEntry, GenreLane } from "../frontend/src/services/catalog/catalogData";

// 所有网页和名称均为合成数据，不访问真实网站或旧数据库。
const seed: GenreEntry[] = [
  { lane: "censored", id: "a", name: "旧版中文分类", category: "类型" },
  { lane: "uncensored", id: "b", name: "另一分类", category: "类型" },
];
const page = (lane: GenreLane, extra = "", name = "远端改名") => `<div class="genre-box">
  <a href="/${lane === "uncensored" ? "uncensored/" : ""}genre/${lane === "censored" ? "a" : "b"}">${name}</a>
  ${Array.from({ length: 50 }, (_, index) => `<a href="https://www.javbus.com/${lane === "uncensored" ? "uncensored/" : ""}genre/id${index}">分类${index}</a>`).join("")}
  ${extra}</div>`;
const pages = { censored: page("censored"), uncensored: page("uncensored") };
const query = { dimension: "genres" as const };
const first = { offset: 0, limit: 100, includeTotal: true };
const now = Date.now();
describe("中文分类解析", () => {
  it("合并成功目录保留旧中文名称、去重，忽略日文标签和站外链接", () => {
    const initial = loadCatalog(seed, null, now);
    const updated = refreshCatalog(
      seed,
      initial.cache,
      {
        ...pages,
        censored: page(
          "censored",
          '<a href="/genre/new">新增分类</a><a href="/genre/jp">テスト</a><a href="https://example.com/genre/evil">站外名称</a>',
        ),
      },
      now,
    );
    expect(updated.names).toContain("旧版中文分类");
    expect(updated.names).not.toContain("远端改名");
    expect(updated.names).toContain("新增分类");
    expect(updated.names).not.toContain("テスト");
    expect(updated.names).not.toContain("站外名称");
    expect(updated.names.length).toBe(53);
    expect(loadCatalog(seed, updated.cache, now).names).toEqual(updated.names);
    const selected = queryCatalog(updated.names, { ...query, names: ["新增分类"] }, first);
    expect(selected.items).toEqual([{ name: "新增分类", count: 0 }]);
    expect(queryCatalog(updated.names, { ...query, names: [] }, first).total).toBe(0);
  });
  it("HTTP 200 验证页和半份目录不能替换缓存", () => {
    const initial = loadCatalog(seed, null, now);
    expect(() =>
      parseGenrePage('<form action="/verify">verification</form>', "censored", seed),
    ).toThrow("有效分类目录");
    expect(() =>
      refreshCatalog(
        seed,
        initial.cache,
        { ...pages, uncensored: '<div class="genre-box"></div>' },
        now,
      ),
    ).toThrow("不完整");
    expect(loadCatalog(seed, initial.cache, now).names).toHaveLength(2);
  });
});
