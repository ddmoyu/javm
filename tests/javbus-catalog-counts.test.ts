import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  javbusEntryFromEntity,
  javbusEntryKey,
  javbusEntryUrl,
  javbusCsvColumns,
  mergeJavbusEntries,
  parseJavbusActresses,
  parseJavbusCsv,
  parseJavbusGenres,
  parseJavbusRelations,
  resolveJavbusCatalogEntities,
  serializeJavbusCsv,
  javbusActressesUrl,
} from "../frontend/src/services/catalog/javbusCatalog";
import type { JavbusCatalogEntry } from "../frontend/src/services/catalog/javbusCatalog";
import {
  parseJavbusWorks,
  parseJavbusWorkDetails,
  planJavbusLookup,
  readJavbusVideoCount,
  isJavbusCatalogUrl,
} from "../frontend/src/services/catalog/javbusWorks";
import { loadDiscovery, mergeDiscovery } from "../frontend/src/services/catalog/discoveryData";
import type { DiscoveryData, DiscoverySeed } from "../frontend/src/services/catalog/discoveryData";
import { queryCatalog } from "../frontend/src/services/catalog/catalogData";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";

const now = Date.parse("2026-10-11T06:00:00Z"),
  origin = "https://www.javbus.com";
const first = { offset: 0, limit: 50, includeTotal: true };
const seed: DiscoverySeed = {
  genres: [],
  actors: [],
  entities: [],
};
const row = (id = "safe", name = "安全演员原名", count?: number): JavbusCatalogEntry =>
  javbusEntryFromEntity(
    { id: `star:${id}`, name, url: `${origin}/star/${id}` },
    "actresses",
    now,
    count,
  );
const actorCard = (id: string, name: string, count?: number, lane = "") =>
  `<a class="avatar-box" href="${lane}/star/${id}" ${count === undefined ? "" : `data-video-count="${count}"`}><img alt="${name}" src="https://images.example.invalid/safe.png"><div class="photo-info"><span>${name}</span></div></a>`;
const workCard =
  '<a class="movie-box" href="/TEST-001"><img title="安全合成示例 2099" src="https://images.example.invalid/safe.png"><date>TEST-001</date></a>';
const work = { code: "TEST-001", title: "安全合成示例 2099", url: `${origin}/TEST-001` };
const detail = `<h3>安全合成示例</h3><nav><a href="/studio/advert">导航不能入库</a></nav><div class="info"><p>识别码: TEST-001</p><p><a href="/director/d1">示例导演</a></p><p><a href="/studio/s1">示例制作商</a></p><p><a href="/label/l1">示例发行商</a></p><p><a href="/series/r1">示例系列</a></p><p><a href="/genre/g1">安全分类</a></p><a href="/star/a1">不能猜测目录归属的演员</a></div>`;
const services: DiscoveryCatalogService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});
function processor(): CatalogProcessor {
  let current: DiscoveryData;
  const run = async (
    operation: CatalogRequest["operation"],
    payload: CatalogRequest["payload"],
  ) => {
    const task = { id: 0, operation, payload } as CatalogRequest;
    switch (task.operation) {
      case "discoveryLoad":
        return (current = loadDiscovery(seed, task.payload.cache, now));
      case "discoveryMerge":
        return (current = mergeDiscovery(seed, task.payload.cache, task.payload.update, now));
      case "javbusActresses":
        return parseJavbusActresses(task.payload.html, task.payload.lane, task.payload.page, now);
      case "javbusImportCsv":
        return Object.entries(task.payload.files).flatMap(([dimension, csv]) =>
          parseJavbusCsv(csv, dimension as JavbusCatalogEntry["dimension"], now),
        );
      case "javbusExportCsv":
        return serializeJavbusCsv(
          (current.javbusEntries ?? []).filter(
            (entry) => entry.dimension === task.payload.dimension,
          ),
          now,
        );
      case "query":
        return queryCatalog(
          task.payload.names,
          task.payload.query,
          task.payload.page,
          task.payload.videoCounts,
        );
      case "javbusPlan": {
        const plan = planJavbusLookup(task.payload.dimension, task.payload.name);
        plan.entities = resolveJavbusCatalogEntities(
          current.javbusEntries ?? [],
          task.payload.dimension,
          plan.names,
        );
        return plan;
      }
      case "javbusWorks":
        return parseJavbusWorks(task.payload.html, task.payload.url, task.payload.page);
      case "javbusDetails":
        return parseJavbusWorkDetails(task.payload.html, task.payload.work);
      case "javbusRelations":
        return parseJavbusRelations(task.payload.html, now);
      default:
        throw new Error("安全样例未定义的操作");
    }
  };
  return { run: run as CatalogProcessor["run"], close: vi.fn() };
}
async function flushUntil(ready: () => boolean) {
  for (let n = 0; n < 300 && !ready(); n++) await Promise.resolve();
  expect(ready()).toBe(true);
}

describe("JavBus 安全目录、CSV 与网站影片数量", () => {
  it("七万五千条内置数量更新能在缓存上限内保存并恢复", () => {
    const entries: JavbusCatalogEntry[] = Array.from({ length: 75_303 }, (_, index) => ({
      dimension: "actresses",
      lane: "censored",
      id: `safe-${index}`,
      name: `安全演员${index}`,
      label: `安全演员${index}`,
      aliases: [],
      translationStatus: "pending",
      category: "",
    }));
    const base = { ...seed, javbusEntries: entries };
    const initial = loadDiscovery(base, null, now);
    const updated = mergeDiscovery(
      base,
      initial.cache,
      {
        javbusRecords: entries.map((entry, index) => ({
          ...entry,
          videoCount: index % 100,
          countUpdatedAt: now + 1,
        })),
      },
      now + 1,
    );
    expect(updated.cache.length).toBeLessThan(16 * 1024 * 1024);
    const restored = loadDiscovery(base, updated.cache, now + 1);
    expect(restored.javbusEntries).toHaveLength(entries.length);
    expect(restored.javbusEntries!.every((entry, index) => entry.videoCount === index % 100)).toBe(
      true,
    );
  });
  it("演员目录可继续第一千页之后，分页游标仍有明确上限", () => {
    const html = actorCard("safe-page", "安全演员甲") + '<a href="/actresses/1001">下一页</a>';
    const result = parseJavbusActresses(html, "censored", 1000, now);
    expect(result.nextPage).toBe(1001);
    expect(isJavbusCatalogUrl(javbusActressesUrl("censored", 1001))).toBe(true);
    expect(isJavbusCatalogUrl(`${origin}/actresses/2001`)).toBe(false);
    const initial = loadDiscovery(seed, null, now);
    initial.javbusPages!.censored = 1000;
    const cached = JSON.stringify({ ...initial, version: 6, cache: undefined });
    const merged = mergeDiscovery(
      seed,
      cached,
      { javbusDirectory: { lane: "censored", entries: result.entries, nextPage: result.nextPage } },
      now,
    );
    expect(loadDiscovery(seed, merged.cache, now).javbusPages!.censored).toBe(1001);
  });
  it("内置目录从快照恢复，数量更新和人工名称仍通过缓存保留", () => {
    const base = { ...seed, javbusEntries: [row("safe-cache", "安全演员原名", 417)] };
    const initial = loadDiscovery(base, null, now);
    expect(JSON.parse(initial.cache).javbusEntries).toEqual([]);
    expect(loadDiscovery(base, initial.cache, now).javbusEntries![0]?.videoCount).toBe(417);
    const countOnly = mergeDiscovery(
      base,
      initial.cache,
      { javbusRecords: [{ ...base.javbusEntries[0]!, videoCount: 0, countUpdatedAt: now + 1 }] },
      now + 1,
    );
    const savedCountOnly = JSON.parse(countOnly.cache);
    expect(savedCountOnly.javbusEntries).toEqual([]);
    expect(savedCountOnly.javbusCountUpdates).toHaveLength(1);
    expect(loadDiscovery(base, countOnly.cache, now + 1).javbusEntries![0]?.videoCount).toBe(0);
    savedCountOnly.javbusCountUpdates[0][3] = -1;
    expect(() => loadDiscovery(base, JSON.stringify(savedCountOnly), now + 1)).toThrow("缓存无效");
    const entry = {
      ...row("safe-cache", "安全演员原名", 100),
      label: "安全校对名称",
      translationStatus: "reviewed" as const,
      countUpdatedAt: now + 1,
    };
    const changed = mergeDiscovery(base, initial.cache, { javbusRecords: [entry] }, now + 1);
    const restored = loadDiscovery(base, changed.cache, now + 1);
    expect(restored.javbusEntries![0]).toMatchObject(entry);
    expect(restored.catalogs.actresses.videoCounts!["安全演员原名"]).toBe(100);
    expect(JSON.parse(changed.cache).javbusEntries).toHaveLength(1);
  });
  it("无名称演员单独报告身份，不伪造名称，也不丢掉同页的有效记录", () => {
    const result = parseJavbusActresses(
      actorCard("safe-a", "安全演员甲", 41) +
        actorCard("safe-empty", "") +
        '<a href="/actresses/2">下一页</a>',
      "censored",
      1,
      now,
    );
    expect(result.entries.map((entry) => entry.id)).toEqual(["safe-a"]);
    expect(result.unnamedIds).toEqual(["safe-empty"]);
    expect(result.nextPage).toBe(2);
    expect(() =>
      parseJavbusActresses(
        actorCard("safe-empty", "") + actorCard("safe-empty", ""),
        "censored",
        1,
        now,
      ),
    ).toThrow("不完整");
  });
  it("名称中的单独角括号保留为文本，成对标签字段仍拒绝", () => {
    const entry = parseJavbusActresses(
      actorCard("safe-symbol", "安全演员&lt;3", 0),
      "censored",
      1,
      now,
    ).entries[0]!;
    expect(entry.name).toBe("安全演员<3");
    expect(parseJavbusCsv(serializeJavbusCsv([entry], now), "actresses", now)).toEqual([entry]);
    expect(() =>
      parseJavbusActresses(actorCard("safe-tag", "&lt;img&gt;"), "censored", 1, now),
    ).toThrow("字段无效");
  });
  it("演员名称属性的多余空白按文本归一，保留有效身份和数量", () => {
    const entries = parseJavbusActresses(
      actorCard("safe-a", "  安全演员\t甲  ", 0),
      "censored",
      1,
      now,
    ).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "safe-a",
      name: "安全演员 甲",
      label: "安全演员 甲",
      videoCount: 0,
    });
    expect(parseJavbusCsv(serializeJavbusCsv(entries, now), "actresses", now)).toEqual(entries);
  });
  it("读取全部影片计数，排除已有磁力子集并保留零值与冲突未知", () => {
    const all = (value: string) =>
      `<a class="mypointer" id="resultshowall">&nbsp;全部影片&nbsp;<span>${value}</span>&nbsp;</a>`;
    const subset = '<a id="resultshowmag">已有磁力&nbsp;195&nbsp;</a>';
    expect(readJavbusVideoCount(all("417") + subset)).toBe(417);
    expect(readJavbusVideoCount(all("1,234") + subset)).toBe(1234);
    expect(readJavbusVideoCount(all("0") + subset)).toBe(0);
    expect(readJavbusVideoCount(subset)).toBeUndefined();
    expect(readJavbusVideoCount(all("417") + '<div data-total-count="418"></div')).toBeUndefined();
    expect(parseJavbusWorks(all("417") + subset + workCard, `${origin}/star/safe`, 1).total).toBe(
      417,
    );
  });
  it("读取两个演员分区，保留 ID、目录顺序和零值，只跟随本分区下一页", () => {
    const html =
      actorCard("z9", "安全演员乙", 120) +
      actorCard("a1", "安全演员甲", 0) +
      '<a href="/actresses/2">下一页</a><a href="/uncensored/actresses/2">其他分区</a>';
    const result = parseJavbusActresses(html, "censored", 1, now);
    expect(result.nextPage).toBe(2);
    expect(result.entries.map((entry) => [entry.id, entry.videoCount])).toEqual([
      ["z9", 120],
      ["a1", 0],
    ]);
    const other = parseJavbusActresses(
      actorCard("z9", "安全演员乙", undefined, "/uncensored"),
      "uncensored",
      1,
      now,
    ).entries[0]!;
    expect(javbusEntryKey(other)).toBe("actresses:uncensored:z9");
    expect(javbusEntryUrl(other)).toBe(`${origin}/uncensored/star/z9`);
    expect(other.videoCount).toBeUndefined();
    expect(() =>
      parseJavbusActresses(actorCard("a1", "安全演员甲", 1, "/uncensored"), "censored", 1, now),
    ).toThrow("不完整");
    expect(() => parseJavbusActresses("<title>Just a moment</title>", "censored", 1, now)).toThrow(
      "验证",
    );
    expect(() =>
      parseJavbusActresses(html + actorCard("a1", "安全演员甲", 0), "censored", 1, now),
    ).toThrow("完整");
  });
  it("只接受明确数量，忽略页数、年份、脚本和作品标题，冲突数量保留未知", () => {
    expect(readJavbusVideoCount("<span>共 1,234 部影片</span>")).toBe(1234);
    expect(readJavbusVideoCount('<span class="video-count">0</span>')).toBe(0);
    expect(readJavbusVideoCount("共 3 页，第 1 页，2026 年")).toBeUndefined();
    expect(readJavbusVideoCount("共 12 部影片，共 13 部影片")).toBeUndefined();
    const result = parseJavbusWorks(
      `<div class="result-count">1,234</div>${workCard}<script>共 999 部影片</script>`,
      `${origin}/star/safe`,
      1,
    );
    expect(result.total).toBe(1234);
    expect(result.items).toHaveLength(1);
    expect(parseJavbusWorks(workCard, `${origin}/star/safe`, 1).total).toBeUndefined();
    expect(
      parseJavbusWorks(
        workCard.replace("安全合成示例 2099", "安全合成示例 100 部影片"),
        `${origin}/star/safe`,
        1,
      ).total,
    ).toBeUndefined();
  });
  it("分类保留目录分组和来源编号，不把数量文本混入名称", () => {
    const html =
      '<div class="genre-box"><h4>安全示例类型</h4>' +
      Array.from(
        { length: 50 },
        (_, n) => `<a href="/genre/g${n}">安全分类${n}<span class="video-count">${n}</span></a>`,
      ).join("") +
      "</div>";
    const entries = parseJavbusGenres(html, "censored", [], now);
    expect(entries[0]).toMatchObject({
      dimension: "genres",
      id: "g0",
      name: "安全分类0",
      category: "安全示例类型",
      videoCount: 0,
    });
    expect(entries.at(-1)?.videoCount).toBe(49);
    expect(() =>
      parseJavbusGenres(
        '<div class="genre-box"><a href="/series/r1">安全系列</a></div>',
        "censored",
        [],
        now,
      ),
    ).toThrow("不完整");
  });
  it("多列 CSV 保留原名、译名、别名、分区、来源网址和数量时间；空数量与零不同", () => {
    const entry = {
      ...row("a1", '安全演员,"甲"', 0),
      label: "安全中文名称",
      aliases: ['安全别名,"甲"'],
      translationStatus: "reviewed" as const,
    };
    const other = { ...row("a1", "安全演员乙"), lane: "uncensored" as const };
    const csv = serializeJavbusCsv([entry, other], now);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(parseJavbusCsv(csv, "actresses", now)).toEqual([entry, other]);
    expect(parseJavbusCsv(serializeJavbusCsv([], now), "actresses", now)).toEqual([]);
    expect(javbusCsvColumns).toContain("video_count");
    expect(() =>
      parseJavbusCsv(
        csv.replace(`${origin}/star/a1`, "https://foreign.example.invalid/star/a1"),
        "actresses",
        now,
      ),
    ).toThrow("CSV 无效");
    expect(() =>
      parseJavbusCsv(serializeJavbusCsv([entry], now).replace(',"0",', ',"-1",'), "actresses", now),
    ).toThrow("CSV 无效");
    expect(() => serializeJavbusCsv([entry, entry], now)).toThrow("无法导出");
    expect(() => parseJavbusCsv(csv, "genres", now)).toThrow("CSV 无效");
    expect(() =>
      parseJavbusCsv(csv.replace("2026-10-11T06:00:00.000Z", "2026-10-11"), "actresses", now),
    ).toThrow("CSV 无效");
  });
  it("新的数量可以减少，旧页或无数量页面不能覆盖已校对名称和较新的数量", () => {
    const old = {
      ...row("safe", "安全演员原名", 100),
      label: "安全校对名称",
      aliases: ["安全别名"],
      translationStatus: "reviewed" as const,
    };
    const missing = { ...row(), aliases: ["另一个安全别名"] };
    expect(mergeJavbusEntries([old], [missing], now)[0]).toMatchObject({
      label: old.label,
      videoCount: 100,
      countUpdatedAt: now,
    });
    expect(
      mergeJavbusEntries(
        [old],
        [{ ...row("safe", old.name, 20), countUpdatedAt: now + 1 }],
        now + 1,
      )[0]?.videoCount,
    ).toBe(20);
    expect(
      mergeJavbusEntries([old], [{ ...row("safe", old.name, 10), countUpdatedAt: now - 1 }], now)[0]
        ?.videoCount,
    ).toBe(100);
    expect(mergeJavbusEntries([old], [{ ...old, label: "新的安全校对名称" }], now)[0]?.label).toBe(
      "新的安全校对名称",
    );
  });
  it("同名不同 ID 的数量不合计；两个明确分区均有数量时才合计", () => {
    const base = loadDiscovery(seed, null, now);
    const a = row("a1", "安全同名演员", 10),
      b = row("a2", a.name, 20);
    expect(
      mergeDiscovery(seed, base.cache, { javbusRecords: [a, b] }, now).catalogs.actresses
        .videoCounts?.[a.name],
    ).toBeUndefined();
    const missing = { ...row("a1", a.name), lane: "uncensored" as const };
    expect(
      mergeDiscovery(seed, base.cache, { javbusRecords: [a, missing] }, now).catalogs.actresses
        .videoCounts?.[a.name],
    ).toBeUndefined();
    const complete = { ...missing, videoCount: 20, countUpdatedAt: now };
    expect(
      mergeDiscovery(seed, base.cache, { javbusRecords: [a, complete] }, now).catalogs.actresses
        .videoCounts?.[a.name],
    ).toBe(30);
  });
  it("CSV 的中文名可显示，校对后的名称随更新生效", () => {
    const base = loadDiscovery(seed, null, now);
    const translated = {
      ...row("new", "安全新来源原名", 10),
      label: "安全新来源中文名",
      translationStatus: "reviewed" as const,
    };
    const data = mergeDiscovery(seed, base.cache, { javbusRecords: [translated] }, now);
    expect(data.catalogs.actresses.labels?.[translated.name]).toBe(translated.label);
    expect(data.catalogs.actresses.videoCounts?.[translated.name]).toBe(10);
    const revised = mergeDiscovery(
      seed,
      data.cache,
      { javbusRecords: [{ ...translated, label: "安全新校对名称" }] },
      now,
    );
    expect(revised.catalogs.actresses.labels?.[translated.name]).toBe("安全新校对名称");
  });
  it("数量降序在分页前执行，零在未知之前，同数量沿用网站顺序", () => {
    const names = ["安全未知", "安全零", "Z安全十", "A安全十", "安全百"];
    const counts = { 安全零: 0, Z安全十: 10, A安全十: 10, 安全百: 100 };
    const query = { dimension: "actresses" as const, sort: "videoCount" as const };
    const values = queryCatalog(names, query, first, counts);
    expect(values.items.map((entry) => entry.name)).toEqual([
      "安全百",
      "Z安全十",
      "A安全十",
      "安全零",
      "安全未知",
    ]);
    expect(queryCatalog(names, query, { ...first, offset: 2, limit: 2 }, counts).items).toEqual(
      values.items.slice(2, 4),
    );
    expect(
      queryCatalog(names, { ...query, names: ["安全零", "安全百"] }, first, counts).items.map(
        (entry) => entry.name,
      ),
    ).toEqual(["安全百", "安全零"]);
    expect(values.items.at(-1)).toEqual({ name: "安全未知", count: 0 });
    expect(
      queryCatalog(names, { ...query, sort: "source" }, first, counts).items.map(
        (entry) => entry.name,
      ),
    ).toEqual(names);
  });
  it("仅从已校验详情信息区汇总导演、制作商、发行商和系列，不猜演员归属", () => {
    parseJavbusWorkDetails(detail, work);
    const entries = parseJavbusRelations(
      detail + '<script><a href="/label/bad">脚本不能入库</a></script>',
      now,
    );
    expect(entries.map((entry) => entry.dimension)).toEqual([
      "directors",
      "studios",
      "labels",
      "series",
      "genres",
    ]);
    expect(entries.every((entry) => entry.videoCount === undefined)).toBe(true);
    expect(entries.map(javbusEntryUrl)).toContain(`${origin}/label/l1`);
    expect(entries.some((entry) => entry.id === "advert")).toBe(false);
  });
  it("重启保留名单、作品数和采集断点，刷新不会继续批量采集", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetch = vi.fn(async () => {
      throw new Error("不应批量采集");
    });
    const cached = mergeDiscovery(
      seed,
      loadDiscovery(seed, null, now).cache,
      {
        javbusRecords: [
          row("safe", "安全演员别名", 12),
          row("zero", "安全零", 0),
          row("other", "安全其他演员", 20),
        ],
      },
      now,
    );
    const write = vi.fn(async (_cache: string) => {}),
      writeCsv = vi.fn(async (_dimension: string, _csv: string) => {});
    const service = new DiscoveryCatalogService(processor(), {
      read: async () => cached.cache,
      write,
      writeCsv,
      fetch,
    });
    services.push(service);
    await service.initialize();
    await service.refresh("actresses");
    await service.refresh("maleActors");
    await service.refresh("actors");
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(writeCsv).not.toHaveBeenCalled();
    expect(
      (await service.query({ dimension: "actresses", sort: "videoCount" }, first)).items.map(
        (entry) => entry.videoCount,
      ),
    ).toEqual([20, 12, 0]);
    await service.refresh("directors");
    await service.refresh("studios");
    await service.refresh("labels");
    expect(fetch).not.toHaveBeenCalled();
    const saved = loadDiscovery(seed, write.mock.calls.at(-1)![0], now);
    expect(saved.javbusPages).toEqual(cached.javbusPages);
    expect(saved.javbusLane).toBe(cached.javbusLane);
  });
  it("已保存 ID 直接打开作品，明确总数回写 CSV；缓存命中不更新数量时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const csv = serializeJavbusCsv([row()], now);
    const fetch = vi.fn(async (url: string) => {
      if (url === `${origin}/star/safe`) return "<p>共 123 部影片</p>" + workCard;
      if (url === work.url) return detail;
      throw new Error("不应再次按名称搜索");
    });
    const writeCsv = vi.fn(async (_dimension: string, _csv: string) => {});
    const service = new DiscoveryCatalogService(processor(), {
      read: async () => null,
      write: async () => {},
      readCsv: async () => ({ actresses: csv }),
      writeCsv,
      fetch,
    });
    services.push(service);
    await service.initialize();
    service.works.select("actresses", "安全演员原名");
    await flushUntil(() => !!service.works.getSnapshot().result);
    expect(service.works.getSnapshot().result?.total).toBe(123);
    expect(service.getSnapshot().catalogs.actresses.videoCounts?.["安全演员原名"]).toBe(123);
    const writes = writeCsv.mock.calls.length;
    service.works.loadPage(1);
    await flushUntil(() => !service.works.getSnapshot().loading);
    expect(writeCsv).toHaveBeenCalledTimes(writes);
    service.works.open(service.works.getSnapshot().result!.items[0]!);
    await flushUntil(() => !!service.works.getSnapshot().detail?.value);
    expect(service.getSnapshot().catalogs.labels.names).toContain("示例发行商");
    expect(writeCsv.mock.calls.some(([dimension]) => dimension === "labels")).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${origin}/star/safe`, work.url]);
  });
  it("取消分类更新不推进游标，也不让迟到响应写入缓存", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let release!: (html: string) => void;
    const write = vi.fn(async (_cache: string) => {});
    const service = new DiscoveryCatalogService(processor(), {
      read: async () => null,
      write,
      fetch: async () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    services.push(service);
    await service.initialize();
    const updating = service.refresh("genres");
    await flushUntil(() => !!release);
    service.cancel();
    release('<div class="genre-box"><a href="/genre/late">安全迟到分类</a></div>');
    await updating;
    expect(write).not.toHaveBeenCalled();
    expect(service.getSnapshot().catalogs.genres.names).not.toContain("安全迟到分类");
  });
  it("CSV 损坏时保留原文件，后续目录刷新仍不能覆盖人工内容", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const writeCsv = vi.fn(async (_dimension: string, _csv: string) => {});
    const service = new DiscoveryCatalogService(processor(), {
      read: async () => null,
      readCsv: async () => ({ actresses: "尚未正确导出的安全人工资料" }),
      write: async () => {},
      writeCsv,
      fetch: async () => actorCard("safe", "安全演员原名", 12),
    });
    services.push(service);
    await service.initialize();
    await service.refresh("actresses");
    expect(service.getSnapshot().catalogs.actresses.videoCounts?.["安全演员原名"]).toBeUndefined();
    expect(service.getSnapshot().warning).toContain("修正后重新启动");
    expect(writeCsv).not.toHaveBeenCalled();
  });
});
