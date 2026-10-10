import { describe, expect, it } from "vite-plus/test";
import { sampleFilms } from "../docs/prototypes/javm-ui/data";
import type { Film } from "../docs/prototypes/javm-ui/data";
import { emptyLibraryFilters, selectLibraryFilms } from "../docs/prototypes/javm-ui/libraryQuery";

const defaults = {
  filters: emptyLibraryFilters(),
  scope: "all" as const,
  query: "",
  sort: "code" as const,
  direction: "asc" as const,
};
const film = (overrides: Partial<Film>): Film => ({
  ...sampleFilms[0]!,
  actor: "林纱月",
  genre: "剧情",
  year: 2025,
  quality: "4K",
  favorite: true,
  missing: false,
  ...overrides,
});
const ids = (films: Film[]) => films.map((item) => item.id);

describe("媒体库组合查询", () => {
  it("同一筛选内取并集，筛选、收藏与搜索之间取交集", () => {
    const source = [
      film({ id: 1, actor: "林纱月", code: "JVM-001" }),
      film({ id: 2, actor: "森川澪", code: "JVM-002" }),
      film({ id: 3, actor: "白石悠", code: "JVM-003" }),
      film({ id: 4, quality: "1080P", code: "JVM-004" }),
      film({ id: 5, year: 2024, code: "JVM-005" }),
      film({ id: 6, genre: "纪实", code: "JVM-006" }),
      film({ id: 7, favorite: false, code: "JVM-007" }),
      film({ id: 8, missing: true, code: "JVM-008" }),
      film({ id: 9, code: "OTHER-009" }),
    ];
    expect(
      ids(
        selectLibraryFilms(source, {
          ...defaults,
          scope: "favorites",
          query: " jvm- ",
          filters: {
            ...emptyLibraryFilters(),
            actors: ["林纱月", "森川澪"],
            genres: ["剧情"],
            years: ["2025"],
            qualities: ["4K"],
            metadata: "complete",
          },
        }),
      ),
    ).toEqual([1, 2]);
    expect(
      ids(
        selectLibraryFilms(source, {
          ...defaults,
          filters: { ...emptyLibraryFilters(), metadata: "missing" },
        }),
      ),
    ).toEqual([8]);
  });

  it("时长区间在 90 和 120 分钟处没有漏项或重复", () => {
    const source = [89, 90, 119, 120].map((duration, index) => film({ id: index + 1, duration }));
    const query = (duration: string) =>
      ids(
        selectLibraryFilms(source, {
          ...defaults,
          filters: { ...emptyLibraryFilters(), duration },
        }),
      );
    expect(query("short")).toEqual([1]);
    expect(query("medium")).toEqual([2, 3]);
    expect(query("long")).toEqual([4]);
  });

  it("统一大小单位后筛选和排序，边界只属于一个区间", () => {
    const source = ["512 MB", "4 GB", "8 GB", "12 GB", "1 TB"].map((size, index) =>
      film({ id: index + 1, size }),
    );
    const query = (size: string) =>
      ids(
        selectLibraryFilms(source, {
          ...defaults,
          filters: { ...emptyLibraryFilters(), size },
        }),
      );
    expect(query("small")).toEqual([1]);
    expect(query("medium")).toEqual([2]);
    expect(query("large")).toEqual([3]);
    expect(query("largest")).toEqual([4, 5]);
    expect(
      ids(selectLibraryFilms(source, { ...defaults, sort: "size", direction: "desc" })),
    ).toEqual([5, 4, 3, 2, 1]);
  });

  it("番号按自然数字排序，切换升降序不修改片库原顺序", () => {
    const source = Object.freeze([
      film({ id: 1000, code: "JVM-1000" }),
      film({ id: 999, code: "JVM-999" }),
      film({ id: 2, code: "JVM-002" }),
    ]);
    expect(ids(selectLibraryFilms(source, defaults))).toEqual([2, 999, 1000]);
    expect(ids(selectLibraryFilms(source, { ...defaults, direction: "desc" }))).toEqual([
      1000, 999, 2,
    ]);
    expect(source.map((item) => item.id)).toEqual([1000, 999, 2]);
  });

  it("查询覆盖全部 5000 条数据，清空条件恢复全部影片", () => {
    const source = Object.freeze([...sampleFilms]);
    expect(ids(selectLibraryFilms(source, { ...defaults, query: "JVM-5000" }))).toEqual([5000]);
    expect(selectLibraryFilms(source, { ...defaults, query: "不存在的影片" })).toHaveLength(0);
    const all = selectLibraryFilms(source, { ...defaults, sort: "added", direction: "desc" });
    expect(all).toHaveLength(5000);
    expect(all[0]!.id).toBe(5000);
    expect(all[4999]!.id).toBe(1);
  });
});
