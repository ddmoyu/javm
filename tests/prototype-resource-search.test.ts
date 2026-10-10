import { describe, expect, it } from "vite-plus/test";
import { sampleFilms } from "../docs/prototypes/javm-ui/data";
import {
  isResourceQueued,
  matchResourceQuery,
  mergeFilmSearchResults,
  mergeResourceResults,
  resourceDownloadTask,
  sampleResourceResults,
  sortResourceResults,
} from "../docs/prototypes/javm-ui/resourceSearch";

describe("统一资源搜索", () => {
  it("规范化番号，精确标题优先；未入库番号仍能交给资源来源查询", () => {
    expect(matchResourceQuery(" jvm_0004 ", sampleFilms)).toMatchObject([
      { code: "JVM-004", libraryId: 4 },
    ]);
    const title = sampleFilms[3]!.title;
    expect(matchResourceQuery(title, sampleFilms)[0]?.libraryId).toBe(4);
    expect(matchResourceQuery("JVM-9001", sampleFilms)).toEqual([{ code: "JVM-9001" }]);
    expect(matchResourceQuery(" ", sampleFilms)).toEqual([]);
    expect(matchResourceQuery("没有这样的标题", sampleFilms)).toEqual([]);
  });
  it("返回全部匹配影片，包含未入库资料且不重复同一番号", () => {
    const matches = matchResourceQuery("JVM", sampleFilms);
    expect(matches).toHaveLength(sampleFilms.length + 4);
    expect(new Set(matches.map((item) => item.code)).size).toBe(matches.length);
    expect(matches.filter((item) => !item.libraryId)).toHaveLength(4);
    expect(matchResourceQuery(sampleFilms[0]!.actor!, sampleFilms).length).toBeGreaterThan(1);
    expect(matchResourceQuery("JVM-004", sampleFilms)).toHaveLength(1);
  });
  it("未入库影片仍有完整资料，空片库也能搜索远程目录", () => {
    const remote = matchResourceQuery("JVM-6001", [])[0]!;
    expect(remote.libraryId).toBeUndefined();
    expect(remote.film?.title).toBeTruthy();
    expect(remote.film?.metadata?.studio).toBeTruthy();
    expect(remote.film?.metadata?.directory).toBe("");
    expect(matchResourceQuery("JVM", [])).toHaveLength(16);
  });
  it("同一番号跨来源、大小写和分隔符合并，保留片库关联与标题差异", () => {
    const film = sampleFilms[0]!;
    const site = {
      code: "jvm_0001",
      film: { ...film, title: "站点标题" },
      metadataSources: ["资料源 A"],
    };
    const local = { code: film.code, film, libraryId: film.id, metadataSources: ["本地片库"] };
    const merged = mergeFilmSearchResults([site, local, site]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      code: "JVM-001",
      libraryId: 1,
      film: { title: film.title },
      metadataSources: ["资料源 A", "本地片库"],
    });
    expect(merged[0]!.aliases).toContain("站点标题");
    expect(site.code).toBe("jvm_0001");
    expect(mergeFilmSearchResults([local, site])[0]!.film?.title).toBe(film.title);
  });
  it("名称相同但番号不同仍分开，合并前后任一标题都可以搜到同一部影片", () => {
    const film = sampleFilms[0]!;
    expect(
      mergeFilmSearchResults([
        { code: film.code, film },
        { code: "JVM-9999", film: { ...film, code: "JVM-9999" } },
      ]),
    ).toHaveLength(2);
    const renamed = { ...film, title: "我编辑的片名" };
    const matches = matchResourceQuery(film.title, [renamed]);
    expect(matches.find((item) => item.code === film.code)).toMatchObject({
      libraryId: film.id,
      film: { title: renamed.title },
      metadataSources: ["本地片库", "资料源 A"],
    });
    expect(matchResourceQuery(renamed.title, [renamed])).toHaveLength(1);
  });
  it("同一资源从多个来源到达时合并来源，重试不重复添加", () => {
    const magnet = sampleResourceResults("JVM-004").find((item) => item.kind === "magnet")!;
    const first = { ...magnet, sources: ["magnet-a" as const] };
    const second = { ...magnet, sources: ["magnet-b" as const] };
    const result = mergeResourceResults([first], [second, first]);
    expect(result).toHaveLength(1);
    expect(result[0]!.sources).toEqual(["magnet-a", "magnet-b"]);
  });
  it("同一磁力即使来源标识、文件名或附加参数不同仍合并，不吞掉不同文件", () => {
    const first = { ...sampleResourceResults("JVM-004")[4]!, sources: ["magnet-a" as const] };
    const hash = new URL(first.url).searchParams.get("xt")!.split(":").at(-1)!;
    const duplicate = {
      ...first,
      id: "site-b:123",
      name: "另一来源的文件名.mkv",
      seeders: null,
      sources: ["magnet-b" as const],
      url: `magnet:?dn=alias&xt=urn:btih:${hash.toUpperCase()}&tr=https://tracker.example.invalid`,
    };
    const different = { ...first, id: "other-file", url: first.url.replace(hash, "f".repeat(40)) };
    const merged = mergeResourceResults([first], [duplicate, different]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      id: first.id,
      seeders: 96,
      sources: ["magnet-a", "magnet-b"],
    });
    expect(first.sources).toEqual(["magnet-a"]);
  });
  it("在线链接相同合并来源，地址或画质参数不同保留独立资源", () => {
    const first = sampleResourceResults("JVM-004")[0]!;
    const duplicate = { ...first, id: "other-source:1", url: first.url + "#player" };
    const different = {
      ...first,
      id: "other-quality:1",
      url: first.url + "?quality=4k",
      quality: "4K" as const,
    };
    expect(mergeResourceResults([first], [duplicate, different])).toHaveLength(2);
  });
  it("做种数未知保留为空，排序落在已知的零之后且不改动原结果", () => {
    const base = sampleResourceResults("JVM-004")[4]!;
    const resources = [
      { ...base, id: "unknown", seeders: null },
      { ...base, id: "zero", seeders: 0 },
      { ...base, id: "available", seeders: 20 },
    ];
    expect(sortResourceResults(resources, "seeders").map((item) => item.id)).toEqual([
      "available",
      "zero",
      "unknown",
    ]);
    expect(resources[0]!.seeders).toBeNull();
  });
  it("未匹配影片的在线资源可入队，去重按资源识别而不误关联其他影片", () => {
    const resource = sampleResourceResults("JVM-9001")[0]!;
    const task = resourceDownloadTask(resource, []);
    expect(task.filmId).toBeUndefined();
    expect(task).toMatchObject({ status: "queued", progress: 0, quality: "1080P" });
    expect(isResourceQueued(resource, [task])).toBe(true);
    expect(isResourceQueued(sampleResourceResults("JVM-9002")[0]!, [task])).toBe(false);
    expect(isResourceQueued(resource, [{ ...task, status: "cancelled" }])).toBe(false);
  });
});
