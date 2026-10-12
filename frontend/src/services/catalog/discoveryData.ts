import { loadCatalog, refreshCatalog } from "./catalogData";
import type { GenreEntry, GenreLane } from "./catalogData";
import { hasControlCharacters } from "./catalogCsv";
import {
  javbusEntryKey,
  mergeJavbusEntries,
  parseJavbusGenres,
  validJavbusEntry,
} from "./javbusCatalog";
import type { JavbusCatalogEntry } from "./javbusCatalog";
import { JAVBUS_ACTRESSES_PAGE_LIMIT } from "./javbusWorks";

export const catalogDimensions = [
  "actors",
  "actresses",
  "maleActors",
  "studios",
  "labels",
  "series",
  "directors",
  "genres",
] as const;
export type CatalogDimension = (typeof catalogDimensions)[number];
export const catalogLabels: Record<CatalogDimension, string> = {
  actors: "演员",
  actresses: "女演员",
  maleActors: "男演员",
  studios: "制作商",
  labels: "发行商",
  series: "系列",
  directors: "导演",
  genres: "分类",
};
export const DISCOVERY_LIMIT = 100_000;
export const DISCOVERY_BYTES = 16 * 1024 * 1024;
export type ActorDirectoryDimension = "actresses" | "maleActors";
export const isActorDirectoryDimension = (
  dimension: string,
): dimension is ActorDirectoryDimension => dimension === "actresses" || dimension === "maleActors";
// 这些维度按 JavBus 记录保持网站顺序；版本 7 之前的缓存名单来自已移除的离线名单，升级时丢弃。
const javbusDirectoryDimensions = new Set<CatalogDimension>([
  "actresses",
  "maleActors",
  "directors",
  "studios",
  "series",
]);
export interface CatalogList {
  names: string[];
  updatedAt: number | null;
  labels?: Record<string, string>;
  videoCounts?: Record<string, number>;
  coverage?: { counts: number; labels: number };
}
export interface CrawlCursor {
  page: string;
  pending: string[];
}
export interface DiscoveryData {
  nativeOverrides?: Record<CatalogDimension, CatalogList & { positions: number[] }>;
  catalogs: Record<CatalogDimension, CatalogList>;
  cursors: Record<GenreLane, CrawlCursor>;
  lane: GenreLane;
  genreCache: string;
  javbusEntries?: JavbusCatalogEntry[];
  javbusPages?: Record<GenreLane, number>;
  javbusLane?: GenreLane;
  javbusOrderSize?: Partial<Record<GenreLane, number>>;
  cache: string;
}
export interface DiscoverySeed {
  genres: GenreEntry[];
  actors: string[];
  javbusEntries?: JavbusCatalogEntry[];
  entities: { dimension: string; name: string }[];
}
export type Additions = Partial<Record<CatalogDimension, string[]>>;
export interface DiscoveryUpdate {
  javbusDirectory?: { lane: GenreLane; entries: JavbusCatalogEntry[]; nextPage: number | null };
  javbusRecords?: JavbusCatalogEntry[];
  genrePages?: Record<GenreLane, string>;
  entities?: { names: Additions; cursor: CrawlCursor; lane: GenreLane };
}
export const isCatalogDimension = (value: string): value is CatalogDimension =>
  (catalogDimensions as readonly string[]).includes(value);
// 升级只淘汰旧快照中的普通未知演员；明确数量和人工名称资料继续保留。
export function retainLegacyJavbusEntries(
  entries: JavbusCatalogEntry[],
  seed: JavbusCatalogEntry[],
) {
  const retained = new Set(seed.map(javbusEntryKey));
  return entries.filter(
    (entry) =>
      !isActorDirectoryDimension(entry.dimension) ||
      entry.videoCount !== undefined ||
      retained.has(javbusEntryKey(entry)) ||
      entry.translationStatus !== "pending" ||
      entry.label !== entry.name ||
      entry.aliases.length > 0,
  );
}
export function nativeCatalogOverrides(baseline: DiscoveryData, data: DiscoveryData) {
  return Object.fromEntries(
    catalogDimensions.map((dimension) => {
      const old = baseline.catalogs[dimension];
      const positions = new Map(old.names.map((name, index) => [name, index]));
      const list = data.catalogs[dimension];
      const changed: CatalogList & { positions: number[] } = {
        names: [],
        positions: [],
        videoCounts: Object.create(null),
        updatedAt: list.updatedAt,
      };
      list.names.forEach((name, index) => {
        if (positions.get(name) === index && old.videoCounts?.[name] === list.videoCounts?.[name])
          return;
        changed.names.push(name);
        changed.positions.push(index);
        if (Object.hasOwn(list.videoCounts ?? {}, name))
          changed.videoCounts![name] = list.videoCounts![name]!;
      });
      return [dimension, changed];
    }),
  ) as NonNullable<DiscoveryData["nativeOverrides"]>;
}
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 128 &&
  !hasControlCharacters(value);
const uniqueNames = (names: string[]) => [...new Set(names)];
const sortNames = (names: string[]) =>
  uniqueNames(names).sort(
    new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" }).compare,
  );
const validTime = (value: unknown, now: number) =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= now + 300_000);
const listPath = (path: string, lane: GenreLane) =>
  (lane === "censored"
    ? /^\/(?:page\/[1-9]\d{0,5})?\/?$/
    : /^\/uncensored(?:\/page\/[1-9]\d{0,5})?\/?$/
  ).test(path);
const moviePath = (path: string) =>
  /^\/[a-z0-9][a-z0-9_-]{2,100}$/i.test(path) &&
  !/^\/(?:actresses|uncensored|genre|studio|label|series|director|search)$/i.test(path);
const cursorValid = (value: CrawlCursor, lane: GenreLane) =>
  value &&
  typeof value.page === "string" &&
  listPath(value.page, lane) &&
  Array.isArray(value.pending) &&
  value.pending.length <= 100 &&
  value.pending.every((path) => typeof path === "string" && moviePath(path));
function applyJavbusCatalogs(data: Omit<DiscoveryData, "cache">) {
  for (const dimension of catalogDimensions) {
    const grouped = new Map<string, JavbusCatalogEntry[]>();
    const sourceRows = (data.javbusEntries ?? []).filter((entry) => entry.dimension === dimension);
    const rows = [
      ...sourceRows.filter((entry) => entry.lane === "censored"),
      ...sourceRows.filter((entry) => entry.lane === "uncensored"),
    ];
    for (const row of rows) {
      const entries = grouped.get(row.name) ?? [];
      entries.push(row);
      grouped.set(row.name, entries);
    }
    const old = data.catalogs[dimension],
      labels: Record<string, string> = Object.assign(Object.create(null), old.labels),
      videoCounts: Record<string, number> = Object.create(null);
    for (const [name, entries] of grouped) {
      const translated = entries.find((entry) => entry.label !== entry.name);
      if (translated) labels[name] = translated.label;
      // 同一 ID 的两个分区分别保存；只有每个分区均有明确数量才合计。
      // 同名多 ID 不推断是同一实体，也不把局部数量冒充总数。
      if (
        new Set(entries.map((entry) => entry.id)).size !== 1 ||
        entries.some((entry) => entry.videoCount === undefined)
      )
        continue;
      const count = entries.reduce((total, entry) => total + entry.videoCount!, 0);
      if (count <= 100_000_000) videoCounts[name] = count;
    }
    const names = uniqueNames([...grouped.keys(), ...old.names]);
    if (names.length > DISCOVERY_LIMIT) throw new Error("名单数量超过限制，已保留原名单。");
    const coverage = { counts: 0, labels: 0 };
    for (const name of names) {
      if (Object.hasOwn(videoCounts, name)) coverage.counts++;
      if (Object.hasOwn(labels, name) && labels[name] !== name) coverage.labels++;
    }
    data.catalogs[dimension] = { ...old, names, labels, videoCounts, coverage };
  }
}
function encode(data: Omit<DiscoveryData, "cache">, seed?: DiscoverySeed): DiscoveryData {
  if (seed) applyJavbusCatalogs(data);
  const baseline = new Map(
    (seed?.javbusEntries ?? []).map((entry) => [javbusEntryKey(entry), entry]),
  );
  // 内置快照可在启动时恢复，缓存只保留身份新增、人工字段或数量的改动。
  const changed: JavbusCatalogEntry[] = [];
  const countUpdates: [string, string, string, number, number][] = [];
  for (const entry of data.javbusEntries ?? []) {
    const old = baseline.get(javbusEntryKey(entry));
    const metadataChanged =
      !old ||
      entry.name !== old.name ||
      entry.label !== old.label ||
      entry.translationStatus !== old.translationStatus ||
      entry.category !== old.category ||
      entry.aliases.length !== old.aliases.length ||
      entry.aliases.some((alias, index) => alias !== old.aliases[index]);
    if (metadataChanged) changed.push(entry);
    else if (entry.videoCount !== old!.videoCount || entry.countUpdatedAt !== old!.countUpdatedAt) {
      if (entry.videoCount === undefined) changed.push(entry);
      else
        countUpdates.push([
          entry.dimension,
          entry.lane,
          entry.id,
          entry.videoCount,
          entry.countUpdatedAt!,
        ]);
    }
  }
  const cache = JSON.stringify({
    version: 8,
    ...data,
    javbusEntries: changed,
    ...(countUpdates.length ? { javbusCountUpdates: countUpdates } : {}),
  });
  if (cache.length > DISCOVERY_BYTES) throw new Error("名单缓存超过大小限制，已保留原名单。");
  return { ...data, cache };
}
export function loadDiscovery(
  seed: DiscoverySeed,
  cache: string | null,
  now: number,
): DiscoveryData {
  const genres = loadCatalog(seed.genres, null, now);
  const catalogs = Object.fromEntries(
    catalogDimensions.map((dimension) => [
      dimension,
      {
        names: sortNames(
          dimension === "genres"
            ? genres.names
            : [
                ...(dimension === "actors" ? seed.actors : []),
                ...seed.entities
                  .filter((entry) => entry.dimension === dimension)
                  .map((entry) => entry.name),
              ],
        ),
        updatedAt: null,
      },
    ]),
  ) as DiscoveryData["catalogs"];
  let data: Omit<DiscoveryData, "cache"> = {
    catalogs,
    genreCache: genres.cache,
    javbusEntries: mergeJavbusEntries([], seed.javbusEntries ?? [], now),
    javbusPages: { censored: 1, uncensored: 1 },
    javbusLane: "censored",
    javbusOrderSize: {},
    lane: "censored",
    cursors: {
      censored: { page: "/", pending: [] },
      uncensored: { page: "/uncensored", pending: [] },
    },
  };
  if (!cache) return encode(data, seed);
  try {
    if (cache.length > DISCOVERY_BYTES) throw new Error();
    const value = JSON.parse(cache);
    // 保留旧版分类缓存，升级不删除用户已获得的名单。
    if (value.version === 1) {
      const old = loadCatalog(seed.genres, cache, now);
      data.catalogs.genres = { names: old.names, updatedAt: old.updatedAt };
      data.genreCache = old.cache;
      return encode(data, seed);
    }
    if (
      ![2, 3, 4, 5, 6, 7, 8].includes(value.version) ||
      typeof value.genreCache !== "string" ||
      !["censored", "uncensored"].includes(value.lane) ||
      !cursorValid(value.cursors?.censored, "censored") ||
      !cursorValid(value.cursors?.uncensored, "uncensored")
    )
      throw new Error();
    for (const dimension of catalogDimensions) {
      // 演员显示名单从保留的身份记录重建，旧全量 names 不再补回未知演员。
      if (isActorDirectoryDimension(dimension)) continue;
      if (value.version < 7 && javbusDirectoryDimensions.has(dimension)) continue;
      // 旧版演员缓存混有其他来源名称，不能据此推断演员的目录归属。
      if (value.version < 4 && dimension === "actors") continue;
      const list = value.catalogs?.[dimension];
      if (
        !list ||
        !Array.isArray(list.names) ||
        list.names.length > DISCOVERY_LIMIT ||
        !list.names.every(validName) ||
        !validTime(list.updatedAt, now)
      )
        throw new Error();
      // JavBus 目录保留网站顺序；其余维度按名称排序。
      const names = javbusDirectoryDimensions.has(dimension)
        ? uniqueNames([...list.names, ...catalogs[dimension].names])
        : sortNames([...catalogs[dimension].names, ...list.names]);
      if (names.length > DISCOVERY_LIMIT) throw new Error();
      catalogs[dimension] = { ...catalogs[dimension], names, updatedAt: list.updatedAt };
    }
    const savedGenres = loadCatalog(seed.genres, value.genreCache, now);
    catalogs.genres = { names: savedGenres.names, updatedAt: savedGenres.updatedAt };
    if (value.version >= 6) {
      if (
        !Array.isArray(value.javbusEntries) ||
        value.javbusEntries.length > DISCOVERY_LIMIT ||
        !value.javbusEntries.every((entry: JavbusCatalogEntry) => validJavbusEntry(entry, now)) ||
        new Set(value.javbusEntries.map(javbusEntryKey)).size !== value.javbusEntries.length ||
        !["censored", "uncensored"].includes(value.javbusLane)
      )
        throw new Error();
      data.javbusEntries = mergeJavbusEntries(
        data.javbusEntries!,
        value.version < 8
          ? retainLegacyJavbusEntries(value.javbusEntries, seed.javbusEntries ?? [])
          : value.javbusEntries,
        now,
      );
      if (value.javbusCountUpdates !== undefined) {
        if (
          !Array.isArray(value.javbusCountUpdates) ||
          value.javbusCountUpdates.length > DISCOVERY_LIMIT
        )
          throw new Error();
        const entries = new Map(data.javbusEntries.map((entry) => [javbusEntryKey(entry), entry]));
        const changes: JavbusCatalogEntry[] = [];
        const seen = new Set<string>();
        for (const update of value.javbusCountUpdates) {
          if (!Array.isArray(update) || update.length !== 5) throw new Error();
          const [dimension, lane, id, videoCount, countUpdatedAt] = update;
          const key = `${dimension}:${lane}:${id}`;
          const old = entries.get(key);
          if (!old && value.version < 8 && isActorDirectoryDimension(dimension)) continue;
          if (!old || seen.has(key)) throw new Error();
          const entry = { ...old, videoCount, countUpdatedAt };
          if (!validJavbusEntry(entry, now)) throw new Error();
          seen.add(key);
          changes.push(entry);
        }
        data.javbusEntries = mergeJavbusEntries(data.javbusEntries, changes, now);
      }
      data.javbusLane = value.javbusLane;
      for (const lane of ["censored", "uncensored"] as const) {
        const page = value.javbusPages?.[lane],
          size = value.javbusOrderSize?.[lane] ?? 0;
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          page > JAVBUS_ACTRESSES_PAGE_LIMIT ||
          !Number.isInteger(size) ||
          size < 0 ||
          (value.version >= 8 &&
            size >
              data.javbusEntries.filter(
                (entry) => entry.dimension === "actresses" && entry.lane === lane,
              ).length)
        )
          throw new Error();
        data.javbusPages![lane] = page;
        data.javbusOrderSize![lane] = value.version < 8 ? 0 : size;
      }
    }
    data = {
      ...data,
      catalogs,
      genreCache: savedGenres.cache,
      lane: value.lane,
      cursors: value.cursors,
    };
    return encode(data, seed);
  } catch {
    throw new Error("名单缓存无效，继续使用内置名单。");
  }
}
export function mergeDiscovery(
  seed: DiscoverySeed,
  cache: string,
  update: DiscoveryUpdate,
  now: number,
) {
  const data = loadDiscovery(seed, cache, now);
  if (update.genrePages) {
    const value = refreshCatalog(seed.genres, data.genreCache, update.genrePages, now);
    data.catalogs.genres = { names: value.names, updatedAt: value.updatedAt };
    data.genreCache = value.cache;
    const entries = (["censored", "uncensored"] as const).flatMap((lane) =>
      parseJavbusGenres(update.genrePages![lane], lane, seed.genres, now),
    );
    data.javbusEntries = mergeJavbusEntries(data.javbusEntries ?? [], entries, now);
  }
  if (update.javbusDirectory) {
    const { lane, entries, nextPage } = update.javbusDirectory;
    if (
      !["censored", "uncensored"].includes(lane) ||
      entries.length > 800 ||
      entries.some((entry) => entry.dimension !== "actresses" || entry.lane !== lane) ||
      (nextPage !== null &&
        (!Number.isInteger(nextPage) ||
          nextPage <= data.javbusPages![lane] ||
          nextPage > JAVBUS_ACTRESSES_PAGE_LIMIT))
    )
      throw new Error("JavBus 演员目录更新无效，已保留原名单。");
    const old = (data.javbusEntries ?? []).filter(
      (entry) => entry.dimension === "actresses" && entry.lane === lane,
    );
    const size = data.javbusPages![lane] === 1 ? 0 : (data.javbusOrderSize?.[lane] ?? 0);
    const prefix = mergeJavbusEntries(old.slice(0, size), entries, now);
    const merged = mergeJavbusEntries(old, entries, now);
    const keys = new Set(prefix.map(javbusEntryKey));
    data.javbusEntries = [
      ...(data.javbusEntries ?? []).filter(
        (entry) => entry.dimension !== "actresses" || entry.lane !== lane,
      ),
      ...prefix,
      ...merged.filter((entry) => !keys.has(javbusEntryKey(entry))),
    ];
    data.javbusPages![lane] = nextPage ?? 1;
    data.javbusOrderSize![lane] = nextPage === null ? 0 : prefix.length;
    data.javbusLane = nextPage === null ? (lane === "censored" ? "uncensored" : "censored") : lane;
    data.catalogs.actresses.updatedAt = now;
  }
  if (update.javbusRecords)
    data.javbusEntries = mergeJavbusEntries(data.javbusEntries ?? [], update.javbusRecords, now);
  if (update.entities) {
    const { names, cursor, lane } = update.entities;
    if (!cursorValid(cursor, lane)) throw new Error("目录更新位置无效，已保留原名单。");
    for (const dimension of catalogDimensions.filter(
      (value) => value !== "genres" && !isActorDirectoryDimension(value),
    )) {
      const incoming = names[dimension] ?? [];
      if (incoming.length > DISCOVERY_LIMIT || !incoming.every(validName))
        throw new Error("目录内容无效，已保留原名单。");
      const old = data.catalogs[dimension];
      data.catalogs[dimension] = {
        names: sortNames([...old.names, ...incoming]),
        updatedAt: dimension === "actors" ? old.updatedAt : now,
      };
    }
    data.cursors[lane] = cursor;
    data.lane = lane === "censored" ? "uncensored" : "censored";
  }
  for (const dimension of catalogDimensions)
    if (data.catalogs[dimension].names.length > DISCOVERY_LIMIT)
      throw new Error("名单数量超过限制，已保留原名单。");
  const { cache: _cache, ...value } = data;
  return encode(value, seed);
}
function text(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, token: string) => {
      if (!token.startsWith("#")) return named[token.toLowerCase()] ?? "";
      const code =
        token[1]?.toLowerCase() === "x"
          ? parseInt(token.slice(2), 16)
          : parseInt(token.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}
function links(html: string) {
  if (html.length > 2 * 1024 * 1024) throw new Error("目录响应过大，已保留原名单。");
  const source = html.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
  return [...source.matchAll(/<a\b([^>]{0,4096})>([^]*?)<\/a\s*>/gi)].flatMap((match) => {
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(match[1]!);
    if (!href || match[2]!.length > 8192) return [];
    try {
      const url = new URL(text(href[2]!), "https://www.javbus.com");
      return url.origin === "https://www.javbus.com" && !url.search && !url.hash
        ? [{ attributes: match[1]!, body: match[2]!, path: url.pathname }]
        : [];
    } catch {
      return [];
    }
  });
}
export function parseListing(html: string, lane: GenreLane): CrawlCursor {
  const anchors = links(html);
  const pending = [
    ...new Set(
      anchors
        .filter(
          (a) => /\bclass\s*=\s*["'][^"']*\bmovie-box\b/i.test(a.attributes) && moviePath(a.path),
        )
        .map((a) => a.path),
    ),
  ];
  if (!pending.length || pending.length > 100)
    throw new Error("网站未返回有效目录，已保留原名单。");
  const next = anchors.find(
    (a) => /\bid\s*=\s*["']next["']/i.test(a.attributes) && listPath(a.path, lane),
  );
  return { pending, page: next?.path ?? (lane === "censored" ? "/" : "/uncensored") };
}
export function parseEntities(html: string): Additions {
  if (!/class\s*=\s*["'][^"']*\binfo\b[^"']*["']/i.test(html))
    throw new Error("网站未返回有效资料，已保留原名单。");
  const kinds: Record<string, CatalogDimension> = {
    star: "actors",
    studio: "studios",
    label: "labels",
    series: "series",
    director: "directors",
  };
  const names: Additions = {};
  for (const link of links(html)) {
    const match =
      /^\/(?:uncensored\/)?(star|studio|label|series|director)\/([a-z0-9_-]{1,32})\/?$/i.exec(
        link.path,
      );
    if (!match) continue;
    const name =
      text(link.body) || text(/\btitle\s*=\s*(["'])([^"']+)\1/i.exec(link.attributes)?.[2] ?? "");
    if (!validName(name)) continue;
    const dimension = kinds[match[1]!.toLowerCase()]!;
    (names[dimension] ??= []).push(name);
  }
  if (!Object.keys(names).length) throw new Error("网站资料结构已变化，已保留原名单。");
  return names;
}
