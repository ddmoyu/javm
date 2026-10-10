import type { FacetQuery, FacetValue, PageRequest, QueryPage } from "../../contracts/library";

export type GenreLane = "censored" | "uncensored";
export interface GenreEntry {
  lane: GenreLane;
  id: string;
  name: string;
  category: string;
}
export interface CatalogData {
  names: string[];
  updatedAt: number | null;
  cache: string;
}
export const CATALOG_LIMIT = 5000;
export const CATALOG_BYTES = 2 * 1024 * 1024;
const key = (entry: GenreEntry) => `${entry.lane}:${entry.id}`;
const textValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  !/[<>\u0000-\u001f\u007f]/u.test(value);
const chineseLabel = (value: string) => !/[\u3040-\u30ff\uff66-\uff9f]/u.test(value);
const entryValid = (entry: GenreEntry) =>
  entry &&
  ["censored", "uncensored"].includes(entry.lane) &&
  typeof entry.id === "string" &&
  /^[a-z0-9_-]{1,32}$/i.test(entry.id) &&
  textValid(entry.name) &&
  chineseLabel(entry.name) &&
  textValid(entry.category);

function readCache(cache: string | null, now: number) {
  if (!cache) return { entries: [] as GenreEntry[], updatedAt: null as number | null };
  try {
    if (cache.length > CATALOG_BYTES) throw new Error();
    const value = JSON.parse(cache) as {
      version: number;
      entries: GenreEntry[];
      updatedAt: number | null;
    };
    if (
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > CATALOG_LIMIT ||
      !value.entries.every(entryValid) ||
      (value.updatedAt !== null &&
        (!Number.isSafeInteger(value.updatedAt) ||
          value.updatedAt <= 0 ||
          value.updatedAt > now + 300_000))
    )
      throw new Error();
    if (new Set(value.entries.map(key)).size !== value.entries.length) throw new Error();
    return value;
  } catch {
    // 不把原始 JSON 或网页片段带到日志、通知中。
    throw new Error("分类缓存无效，继续使用内置名单。");
  }
}
function mergeEntries(base: GenreEntry[], additions: GenreEntry[]) {
  const merged = new Map(base.map((entry) => [key(entry), entry]));
  for (const entry of additions) if (!merged.has(key(entry))) merged.set(key(entry), entry);
  if (merged.size > CATALOG_LIMIT) throw new Error("分类数量超过限制，已保留原名单。");
  return [...merged.values()];
}
function result(entries: GenreEntry[], updatedAt: number | null): CatalogData {
  const names = [...new Set(entries.map((entry) => entry.name))];
  names.sort(new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" }).compare);
  return { names, updatedAt, cache: JSON.stringify({ version: 1, entries, updatedAt }) };
}
export function loadCatalog(seed: GenreEntry[], cache: string | null, now: number): CatalogData {
  const saved = readCache(cache, now);
  return result(mergeEntries(seed, saved.entries), saved.updatedAt);
}
function decodeText(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, token: string) => {
      if (!token.startsWith("#")) return entities[token.toLowerCase()] ?? "";
      const code =
        token[1]?.toLowerCase() === "x"
          ? Number.parseInt(token.slice(2), 16)
          : Number.parseInt(token.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    })
    .trim();
}

// 只识别目录页的分类链接，绝不渲染 HTML，也不读取图片或作品链接。
export function parseGenrePage(html: string, lane: GenreLane, known: GenreEntry[]) {
  if (html.length > CATALOG_BYTES || !/class\s*=\s*["'][^"']*\bgenre-box\b/i.test(html))
    throw new Error("网站未返回有效分类目录，已保留原名单。");
  const source = html.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
  const seen = new Set<string>();
  const entries: GenreEntry[] = [];
  for (const match of source.matchAll(/<a\b([^>]{0,4096})>([^]*?)<\/a\s*>/gi)) {
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(match[1]!);
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeText(href[2]!), "https://www.javbus.com");
    } catch {
      continue;
    }
    if (url.origin !== "https://www.javbus.com" || url.search || url.hash) continue;
    const path = /^\/(uncensored\/)?genre\/([a-z0-9_-]{1,32})\/?$/i.exec(url.pathname);
    if (!path || (path[1] ? "uncensored" : "censored") !== lane) continue;
    const id = path[2]!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (match[2]!.length > 2048) continue;
    const name = decodeText(match[2]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ");
    const entry = { lane, id, name, category: "其他" };
    if (entryValid(entry)) entries.push(entry);
  }
  const expected = known.filter((entry) => entry.lane === lane);
  // 验证页、截断页面和站点改版均不能成为新缓存；允许少量上游条目下架。
  if (
    seen.size < 50 ||
    expected.filter((entry) => seen.has(entry.id)).length < expected.length * 0.8
  )
    throw new Error("网站分类目录不完整，已保留原名单。");
  return entries;
}
export function refreshCatalog(
  seed: GenreEntry[],
  cache: string,
  pages: Record<GenreLane, string>,
  now: number,
): CatalogData {
  const saved = readCache(cache, now);
  const current = mergeEntries(seed, saved.entries);
  const incoming = (["censored", "uncensored"] as const).flatMap((lane) =>
    parseGenrePage(pages[lane], lane, seed),
  );
  // 同一来源 ID 保留已有中文名，网络短暂缺项也不删除本地条目。
  return result(mergeEntries(current, incoming), now);
}
export function queryCatalog(
  names: string[],
  query: FacetQuery,
  page: PageRequest,
): QueryPage<FacetValue> {
  const search = query.query?.trim().toLocaleLowerCase() ?? "";
  const selected = query.names ? new Set(query.names) : undefined;
  const matches = names.filter(
    (name) =>
      (!search || name.toLocaleLowerCase().includes(search)) && (!selected || selected.has(name)),
  );
  if (query.sort === "name")
    matches.sort(new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" }).compare);
  return {
    items: matches.slice(page.offset, page.offset + page.limit).map((name) => ({ name, count: 0 })),
    offset: page.offset,
    total: matches.length,
    available: names.length,
  };
}
