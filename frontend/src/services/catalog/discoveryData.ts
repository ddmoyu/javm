import { loadCatalog, refreshCatalog } from "./catalogData";
import type { GenreEntry, GenreLane } from "./catalogData";
import { avwikiSources, hasControlCharacters, isAvwikiDimension } from "./avwikiCsv";
import type { AvwikiDimension, AvwikiEntry } from "./avwikiCsv";
import { validPortraitUrl } from "./portraitUrls";

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
export const ACTOR_SOURCE = "https://avwikidb.com/actor/";
export const actorDirectorySources = {
  actresses: ACTOR_SOURCE,
  maleActors: "https://avwikidb.com/histrion/",
} as const;
export type ActorDirectoryDimension = keyof typeof actorDirectorySources;
export const isActorDirectoryDimension = (
  dimension: string,
): dimension is ActorDirectoryDimension => dimension === "actresses" || dimension === "maleActors";
export interface CatalogList {
  names: string[];
  updatedAt: number | null;
  labels?: Record<string, string>;
  seedAt?: number;
}
export interface CrawlCursor {
  page: string;
  pending: string[];
}
export interface DiscoveryData {
  catalogs: Record<CatalogDimension, CatalogList>;
  actorPages: Record<ActorDirectoryDimension, number>;
  directoryPages: Record<AvwikiDimension, number>;
  directoryPortraits: Record<ActorDirectoryDimension, Record<string, string>>;
  cursors: Record<GenreLane, CrawlCursor>;
  lane: GenreLane;
  genreCache: string;
  cache: string;
}
export interface DiscoverySeed {
  genres: GenreEntry[];
  actors: string[];
  actorDirectories?: Partial<Record<ActorDirectoryDimension, string[]>>;
  avwikiDirectories?: Record<AvwikiDimension, AvwikiEntry[]>;
  avwikiCollectedAt?: number;
  entities: { dimension: string; name: string }[];
}
export type Additions = Partial<Record<CatalogDimension, string[]>>;
export interface DiscoveryUpdate {
  directory?: {
    dimension: AvwikiDimension;
    names: string[];
    nextPage: number | null;
    portraits?: Record<string, string>;
  };
  actorDirectory?: {
    dimension: ActorDirectoryDimension;
    names: string[];
    nextPage: number | null;
  };
  genrePages?: Record<GenreLane, string>;
  entities?: { names: Additions; cursor: CrawlCursor; lane: GenreLane };
}
export const isCatalogDimension = (value: string): value is CatalogDimension =>
  (catalogDimensions as readonly string[]).includes(value);
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 128 &&
  !hasControlCharacters(value);
const sortNames = (names: string[]) =>
  [...new Set(names)].sort(
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
function encode(data: Omit<DiscoveryData, "cache">): DiscoveryData {
  return { ...data, cache: JSON.stringify({ version: 4, ...data }) };
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
          isAvwikiDimension(dimension) && seed.avwikiDirectories
            ? seed.avwikiDirectories[dimension].map((entry) => entry.name)
            : dimension === "genres"
              ? genres.names
              : isActorDirectoryDimension(dimension)
                ? (seed.actorDirectories?.[dimension] ?? [])
                : dimension === "actors"
                  ? [
                      ...seed.actors,
                      ...seed.entities
                        .filter((entry) => entry.dimension === dimension)
                        .map((entry) => entry.name),
                    ]
                  : seed.entities
                      .filter((entry) => entry.dimension === dimension)
                      .map((entry) => entry.name),
        ),
        updatedAt: null,
        ...(isAvwikiDimension(dimension) && seed.avwikiCollectedAt
          ? { seedAt: seed.avwikiCollectedAt }
          : {}),
        ...(isAvwikiDimension(dimension) && seed.avwikiDirectories
          ? {
              labels: Object.fromEntries(
                seed.avwikiDirectories[dimension]
                  .filter((entry) => entry.label !== entry.name)
                  .map((entry) => [entry.name, entry.label]),
              ),
            }
          : {}),
      },
    ]),
  ) as DiscoveryData["catalogs"];
  let data: Omit<DiscoveryData, "cache"> = {
    catalogs,
    actorPages: { actresses: 1, maleActors: 1 },
    directoryPages: { actresses: 1, maleActors: 1, directors: 1, studios: 1, series: 1 },
    directoryPortraits: { actresses: {}, maleActors: {} },
    genreCache: genres.cache,
    lane: "censored",
    cursors: {
      censored: { page: "/", pending: [] },
      uncensored: { page: "/uncensored", pending: [] },
    },
  };
  if (!cache) return encode(data);
  try {
    if (cache.length > DISCOVERY_BYTES) throw new Error();
    const value = JSON.parse(cache);
    // 保留旧版分类缓存，升级不删除用户已获得的名单。
    if (value.version === 1) {
      const old = loadCatalog(seed.genres, cache, now);
      data.catalogs.genres = { names: old.names, updatedAt: old.updatedAt };
      data.genreCache = old.cache;
      return encode(data);
    }
    if (
      ![2, 3, 4].includes(value.version) ||
      typeof value.genreCache !== "string" ||
      !["censored", "uncensored"].includes(value.lane) ||
      !cursorValid(value.cursors?.censored, "censored") ||
      !cursorValid(value.cursors?.uncensored, "uncensored")
    )
      throw new Error();
    for (const dimension of catalogDimensions) {
      // 五类目录以 AVWikiDB 为准，不混入旧 JavBus/GFriends 名称。
      if (
        value.version < 4 &&
        seed.avwikiDirectories &&
        (dimension === "actors" || isAvwikiDimension(dimension))
      )
        continue;
      // 旧版演员缓存混有 GFriends 名称，不能据此推断演员的目录归属。
      if (value.version === 2 && (dimension === "actors" || isActorDirectoryDimension(dimension)))
        continue;
      const list = value.catalogs?.[dimension];
      if (
        !list ||
        !Array.isArray(list.names) ||
        list.names.length > DISCOVERY_LIMIT ||
        !list.names.every(validName) ||
        !validTime(list.updatedAt, now)
      )
        throw new Error();
      const names = sortNames([...catalogs[dimension].names, ...list.names]);
      if (names.length > DISCOVERY_LIMIT) throw new Error();
      catalogs[dimension] = { ...catalogs[dimension], names, updatedAt: list.updatedAt };
    }
    const savedGenres = loadCatalog(seed.genres, value.genreCache, now);
    catalogs.genres = { names: savedGenres.names, updatedAt: savedGenres.updatedAt };
    if (value.version === 3 && !seed.avwikiDirectories) {
      for (const dimension of ["actresses", "maleActors"] as const) {
        const page = value.actorPages?.[dimension];
        if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error();
        data.actorPages[dimension] = page;
        data.directoryPages[dimension] = page;
      }
    }
    if (value.version === 4) {
      for (const dimension of Object.keys(avwikiSources) as AvwikiDimension[]) {
        const page = value.directoryPages?.[dimension];
        if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error();
        data.directoryPages[dimension] = page;
        if (isActorDirectoryDimension(dimension)) data.actorPages[dimension] = page;
      }
      for (const dimension of ["actresses", "maleActors"] as const) {
        const images = value.directoryPortraits?.[dimension] ?? {};
        if (
          !images ||
          typeof images !== "object" ||
          Array.isArray(images) ||
          Object.keys(images).length > DISCOVERY_LIMIT ||
          Object.entries(images).some(
            ([name, url]) => !validName(name) || typeof url !== "string" || !validPortraitUrl(url),
          )
        )
          throw new Error();
        data.directoryPortraits[dimension] = images;
      }
    }
    data = {
      ...data,
      catalogs,
      genreCache: savedGenres.cache,
      lane: value.lane,
      cursors: value.cursors,
    };
    return encode(data);
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
  if (update.directory) {
    const { dimension, names, nextPage } = update.directory;
    if (
      !isAvwikiDimension(dimension) ||
      names.length > 1000 ||
      !names.every(validName) ||
      (nextPage !== null && (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > 1000))
    )
      throw new Error("目录更新无效，已保留原名单。");
    data.catalogs[dimension] = {
      ...data.catalogs[dimension],
      names: sortNames([...data.catalogs[dimension].names, ...names]),
      updatedAt: now,
    };
    data.directoryPages[dimension] = nextPage ?? 1;
    if (isActorDirectoryDimension(dimension)) data.actorPages[dimension] = nextPage ?? 1;
    if (isActorDirectoryDimension(dimension) && update.directory.portraits) {
      const images = update.directory.portraits;
      if (
        Object.keys(images).length > 1000 ||
        Object.entries(images).some(
          ([name, url]) => !names.includes(name) || !validName(name) || !validPortraitUrl(url),
        )
      )
        throw new Error("目录头像地址无效，已保留原名单。");
      data.directoryPortraits[dimension] = { ...data.directoryPortraits[dimension], ...images };
      if (Object.keys(data.directoryPortraits[dimension]).length > DISCOVERY_LIMIT)
        throw new Error("目录头像数量超过限制，已保留原名单。");
    }
  }
  if (update.actorDirectory) {
    const { dimension, names, nextPage } = update.actorDirectory;
    if (
      !isActorDirectoryDimension(dimension) ||
      names.length > 1000 ||
      !names.every(validName) ||
      (nextPage !== null && (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > 1000))
    )
      throw new Error("演员目录更新无效，已保留原名单。");
    data.catalogs[dimension] = {
      names: sortNames([...data.catalogs[dimension].names, ...names]),
      updatedAt: now,
    };
    data.actorPages[dimension] = nextPage ?? 1;
  }
  if (update.genrePages) {
    const value = refreshCatalog(seed.genres, data.genreCache, update.genrePages, now);
    data.catalogs.genres = { names: value.names, updatedAt: value.updatedAt };
    data.genreCache = value.cache;
  }
  if (update.entities) {
    const { names, cursor, lane } = update.entities;
    if (!cursorValid(cursor, lane)) throw new Error("目录更新位置无效，已保留原名单。");
    for (const dimension of catalogDimensions.filter(
      (value) =>
        value !== "genres" &&
        !isActorDirectoryDimension(value) &&
        !(seed.avwikiDirectories && isAvwikiDimension(value)),
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
  return encode(value);
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

export function parseActorDirectory(
  html: string,
  dimension: ActorDirectoryDimension,
  page: number,
) {
  return parseAvwikiDirectory(html, dimension, page);
}
export function parseAvwikiDirectory(html: string, dimension: AvwikiDimension, page: number) {
  if (html.length > 2 * 1024 * 1024 || !Number.isInteger(page) || page < 1 || page > 1000)
    throw new Error("演员目录响应无效，已保留原名单。");
  const kind = new URL(avwikiSources[dimension]).pathname.split("/")[1]!;
  const source = html.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
  const total = Number(
    text(source)
      .match(/全\s*([\d,]+)\s*件/)?.[1]
      ?.replaceAll(",", ""),
  );
  const entries = new Map<string, string>();
  let invalidIds = 0;
  let nextPage: number | null = null;
  const grid =
    /<ul\b[^>]*class\s*=\s*["'][^"']*\bentity-grid\b[^"']*["'][^>]*>([^]*?)<\/ul\s*>/i.exec(
      source,
    )?.[1];
  if (!grid) throw new Error("来源未返回目录主列表，已保留原名单。");
  for (const match of grid.matchAll(/<a\b([^>]{0,4096})>([^]*?)<\/a\s*>/gi)) {
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(match[1]!);
    if (!href || match[2]!.length > 8192) continue;
    let url: URL;
    try {
      url = new URL(text(href[2]!), avwikiSources[dimension]);
    } catch {
      continue;
    }
    if (url.origin !== "https://avwikidb.com" || url.hash) continue;
    // 来源偶有无编号的 /null/ 条目，只跳过这种已知异常。
    if (url.pathname === `/${kind}/null/` && !url.search) {
      invalidIds++;
      continue;
    }
    const entity = new RegExp(`^/${kind}/([a-z]?[0-9]+)/?$`).exec(url.pathname);
    if (entity && !url.search) {
      const name = text(match[2]!);
      if (validName(name)) entries.set(entity[1]!, name);
    }
  }
  const next = new RegExp(`href\\s*=\\s*["']/${kind}/\\?page=${page + 1}["']`, "i");
  if (next.test(source)) nextPage = page + 1;
  const portraits: Record<string, string> = Object.create(null);
  if (isActorDirectoryDimension(dimension)) {
    const counts = new Map<string, number>();
    for (const name of entries.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const card of grid.matchAll(/<li\b[^>]*>([^]*?)<\/li\s*>/gi)) {
      const id = new RegExp(`href\\s*=\\s*["']/${kind}/([a-z]?[0-9]+)/["']`, "i").exec(
        card[1]!,
      )?.[1];
      const name = id && entries.get(id);
      const image = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(card[1]!)?.[2];
      if (name && counts.get(name) === 1 && image && validPortraitUrl(text(image)))
        portraits[name] = text(image);
    }
  }
  const expected = Math.min(100, total - (page - 1) * 100);
  if (
    !Number.isInteger(total) ||
    total < 1 ||
    total > DISCOVERY_LIMIT ||
    expected < 1 ||
    entries.size + invalidIds !== expected ||
    (total > page * 100 && nextPage === null)
  )
    throw new Error("演员来源未返回完整目录分页，已保留原名单。");
  return {
    names: sortNames([...entries.values()]),
    nextPage,
    ...(Object.keys(portraits).length ? { portraits } : {}),
  };
}
