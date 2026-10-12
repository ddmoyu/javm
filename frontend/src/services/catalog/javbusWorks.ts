import type { MovieDetails } from "../metadata/MetaTubeService";
import { normalizeCode } from "../scraping/identity";
import { hasControlCharacters } from "./catalogCsv";
import type { OnlineEntity, OnlineWork, OnlineWorksPage } from "./onlineWorks";
import type { GenreEntry, GenreLane } from "./catalogData";

export type WorksDimension =
  | "actresses"
  | "maleActors"
  | "directors"
  | "studios"
  | "series"
  | "genres"
  | "labels";
export interface JavbusPlan {
  names: string[];
  queries: string[];
  entities: OnlineEntity[];
}
export const JAVBUS_ORIGIN = "https://www.javbus.com";
export const JAVBUS_ACTRESSES_PAGE_LIMIT = 2000;
const routes = {
  actresses: "star",
  maleActors: "star",
  directors: "director",
  studios: "studio",
  series: "series",
  genres: "genre",
  labels: "label",
} as const;
const pageValid = (page: number) => Number.isInteger(page) && page >= 1 && page <= 1000;
const nameKey = (name: string) => name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const pagePattern = "(?:[1-9]\\d{0,2}|1000)";
const entityPattern =
  /^\/(?:uncensored\/)?(star|studio|label|series|director|genre)\/[a-z0-9_-]{1,100}$/i;
const workPattern = /^\/(?:uncensored\/)?(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{2,100}$/i;
// 同番号不同发行版本的来源地址可附带日期，保留完整 URL，身份仍由详情中的番号确认。
const pathCode = (url: URL) =>
  url.pathname
    .split("/")
    .at(-1)!
    .replace(/_\d{4}-\d{2}-\d{2}$/, "");

export function sourceUrl(value: string, base = JAVBUS_ORIGIN): URL | undefined {
  if (hasControlCharacters(value) || /\\|%(?:2f|5c|00)/i.test(value)) return;
  try {
    const url = new URL(value, base);
    if (url.origin === "https://javbus.com") url.hostname = "www.javbus.com";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
    if (url.origin === JAVBUS_ORIGIN && !url.username && !url.password && !url.hash && !url.search)
      return url;
  } catch {
    /* 页面中的无效或外站链接不参与导航。 */
  }
}
export function isJavbusCatalogUrl(value: string) {
  if (!value.startsWith(`${JAVBUS_ORIGIN}/`)) return false;
  const url = sourceUrl(value);
  if (!url) return false;
  const path = url.pathname;
  if (/^\/(?:uncensored\/?)?$/.test(path) || workPattern.test(path)) return true;
  if (/^\/(?:uncensored\/)?actresses(?:\/(?:[1-9]\d{0,2}|1\d{3}|2000))?$/.test(path)) return true;
  if (new RegExp(`^/(?:uncensored/)?genre(?:/${pagePattern})?$`).test(path)) return true;
  if (new RegExp(`^/(?:uncensored/)?page/${pagePattern}$`).test(path)) return true;
  if (
    entityPattern.test(path) ||
    entityPattern.test(path.replace(new RegExp(`/${pagePattern}$`), ""))
  )
    return true;
  const search = /^\/(?:uncensored\/)?(?:searchstar|search)\/([^/]+)(?:\/(\d+))?$/.exec(path);
  if (!search || (search[2] && !pageValid(Number(search[2])))) return false;
  try {
    const query = decodeURIComponent(search[1]!);
    return (
      !!query.trim() &&
      query.length <= 128 &&
      !/[\\/?#%]/.test(query) &&
      !hasControlCharacters(query)
    );
  } catch {
    return false;
  }
}
export function isJavbusWorksUrl(value: string) {
  const url = sourceUrl(value);
  if (!value.startsWith("https://") || !url || !isJavbusCatalogUrl(url.href)) return false;
  const path = url.pathname;
  return (
    workPattern.test(path) ||
    /\/(star|studio|label|series|director|genre|searchstar|search)\//.test(path)
  );
}
export function javbusSearchUrl(dimension: WorksDimension, name: string, lane: GenreLane) {
  const type = dimension === "actresses" || dimension === "maleActors" ? "searchstar" : "search";
  const url = `${JAVBUS_ORIGIN}${lane === "uncensored" ? "/uncensored" : ""}/${type}/${encodeURIComponent(name)}`;
  if (!isJavbusCatalogUrl(url)) throw new Error("JavBus 搜索名称无效。");
  return url;
}
export function javbusEntityUrl(entity: OnlineEntity, page = 1) {
  const url = sourceUrl(entity.url);
  if (!url || !entityPattern.test(url.pathname) || !pageValid(page))
    throw new Error("JavBus 作品目录地址无效。");
  return `${url.href}${page === 1 ? "" : `/${page}`}`;
}
function aliases(name: string) {
  const value = name.normalize("NFKC");
  const main = value.split("(")[0]!.trim();
  return [
    value,
    main,
    ...[...value.matchAll(/\(([^()]*)\)/g)].flatMap((m) => m[1]!.split(/[、,，;；]/)),
  ]
    .map((part) => part.trim())
    .filter((part) => part && part.length <= 128 && !hasControlCharacters(part));
}
export function planJavbusLookup(
  dimension: WorksDimension,
  name: string,
  genres: GenreEntry[] = [],
): JavbusPlan {
  const wanted = nameKey(name);
  const names = [...new Set(aliases(name))];
  const queries = [...new Set(names.map((value) => value.split("(")[0]!.trim()))]
    .filter((value) => value && !/[\\/?#%]/.test(value))
    .slice(0, 3);
  const entities =
    dimension === "genres"
      ? genres
          .filter((entry) => nameKey(entry.name) === wanted)
          .map((entry) => ({
            id: `${entry.lane}:${entry.id}`,
            name: entry.name,
            url: `${JAVBUS_ORIGIN}${entry.lane === "uncensored" ? "/uncensored" : ""}/genre/${entry.id}`,
          }))
      : [];
  return { names, queries, entities };
}

function decode(value: string) {
  const known: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, token: string) => {
    if (!token.startsWith("#")) return known[token.toLowerCase()]!;
    const hex = token[1]?.toLowerCase() === "x";
    const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : "";
  });
}
export const plain = (value: string) =>
  decode(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
export const attribute = (attrs: string, name: string) =>
  decode(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([^]*?)\\1`, "i").exec(attrs)?.[2] ?? "");
export const hasClass = (attrs: string, name: string) =>
  attribute(attrs, "class").split(/\s+/).includes(name);
export function documentSource(html: string) {
  if (!html || html.length > 2 * 1024 * 1024) throw new Error("JavBus 页面为空或超过大小限制。");
  if (/\bid\s*=\s*["']challenge-(?:running|stage)|<title>\s*Just a moment/i.test(html))
    throw new Error("JavBus 页面要求验证，已结束读取。");
  return html.replace(/<!--[^]*?-->|<(script|style|template)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
}
export function anchors(source: string) {
  return [...source.matchAll(/<a\b([^>]{0,4096})>([^]*?)<\/a\s*>/gi)].filter(
    (m) => m[2]!.length <= 64 * 1024,
  );
}
// 仅定位结构容器；HTML 解析全部在 Catalog Worker 内，不挂载到 DOM。
export function infoBlock(source: string) {
  const tags = source.matchAll(/<\/?div\b[^>]*>/gi);
  let start = -1,
    depth = 0;
  for (const tag of tags) {
    const closing = tag[0].startsWith("</");
    if (start < 0) {
      if (!closing && hasClass(tag[0].slice(4, -1), "info")) {
        start = tag.index + tag[0].length;
        depth = 1;
      }
    } else {
      depth += closing ? -1 : 1;
      if (depth === 0) return source.slice(start, tag.index);
    }
  }
  throw new Error("JavBus 未返回完整作品详情。");
}
function imageUrl(value: string, base = JAVBUS_ORIGIN) {
  if (!value || value.length > 2048 || hasControlCharacters(value)) return;
  try {
    const url = new URL(value, base);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    /* 无效图片保留占位。 */
  }
}
function imageUrls(attrs: string, base = JAVBUS_ORIGIN) {
  const values = [
    attribute(attrs, "data-src"),
    attribute(attrs, "data-original"),
    attribute(attrs, "src"),
    ...attribute(attrs, "data-srcset")
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0] ?? ""),
    ...attribute(attrs, "srcset")
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0] ?? ""),
  ];
  return [
    ...new Set(values.map((value) => imageUrl(value, base)).filter((url): url is string => !!url)),
  ].slice(0, 8);
}
function previewImages(source: string, base: string) {
  const images = new Set<string>();
  for (const sample of anchors(source)) {
    // 只读取样品图链接，不把封面、演员头像和相关推荐混入截图。
    if (!hasClass(sample[1]!, "sample-box")) continue;
    const href = attribute(sample[1]!, "href").trim();
    const img = /<img\b([^>]{0,4096})>/i.exec(sample[2]!)?.[1] ?? "";
    const url =
      (href && !href.startsWith("#") ? imageUrl(href, base) : undefined) ?? imageUrls(img, base)[0];
    if (url) images.add(url);
    if (images.size >= 100) break;
  }
  return [...images];
}
export function entityOf(href: string, name: string, dimension: WorksDimension) {
  const url = sourceUrl(href);
  const match = url && entityPattern.exec(url.pathname);
  if (!url || !match || match[1] !== routes[dimension] || !name || name.length > 128) return;
  return { id: url.pathname.slice(1).replaceAll("/", ":"), name, url: url.href };
}
const emptyResult = (source: string) =>
  /(?:沒有|没有)(?:您|你)要的(?:結果|结果)|(?:沒有|没有|無|无|沒有找到|没有找到)(?:找到)?(?:相關|相关)?(?:的)?(?:影片|演員|演员|結果|结果)|No (?:results|movies|actresses) found/i.test(
    plain(source),
  );
export function parseJavbusActors(html: string, names?: string[]): OnlineEntity[] {
  const source = documentSource(html),
    wanted = names && new Set(names.flatMap(aliases).map(nameKey));
  const entries = new Map<string, OnlineEntity>();
  let cards = 0;
  for (const match of anchors(source)) {
    if (!hasClass(match[1]!, "avatar-box")) continue;
    cards++;
    const img = /<img\b([^>]{0,4096})>/i.exec(match[2]!)?.[1] ?? "";
    const name = attribute(img, "title") || attribute(img, "alt") || plain(match[2]!);
    const entity = entityOf(attribute(match[1]!, "href"), name, "actresses");
    if (entity && (!wanted || aliases(name).some((value) => wanted.has(nameKey(value)))))
      entries.set(entity.id, entity);
  }
  if (!cards && !emptyResult(source)) throw new Error("未识别到 JavBus 演员搜索结果，已结束读取。");
  if (!names && cards && !entries.size) throw new Error("演员搜索结果结构无效，请重试。");
  if (entries.size > 100) throw new Error("JavBus 演员搜索单页超过上限，请缩小关键词。");
  return [...entries.values()];
}
export function parseJavbusActorSearch(html: string, url: string, page: number) {
  if (!isJavbusCatalogUrl(url) || !/\/searchstar\//.test(url) || !pageValid(page))
    throw new Error("演员搜索分页无效。");
  const match = /^\/(?:uncensored\/)?searchstar\/[^/]+(?:\/(\d+))?$/.exec(new URL(url).pathname);
  if (!match || Number(match[1] ?? 1) !== page) throw new Error("演员搜索页码与地址不一致。");
  const source = documentSource(html);
  const items = parseJavbusActors(source);
  const base = page === 1 ? url : url.replace(new RegExp(`/${page}$`), "");
  const nextPage =
    page < 1000 &&
    anchors(source).some(
      (match) => sourceUrl(attribute(match[1]!, "href"), url)?.href === `${base}/${page + 1}`,
    )
      ? page + 1
      : null;
  if (!items.length && nextPage) throw new Error("演员搜索分页内容不完整，请重试。");
  return { items, nextPage };
}
export function parseJavbusFacets(
  html: string,
  dimension: WorksDimension,
  names: string[],
): OnlineEntity[] {
  const source = infoBlock(documentSource(html)),
    wanted = new Set(names.map(nameKey));
  const entries = new Map<string, OnlineEntity>();
  for (const match of anchors(source)) {
    const name = plain(match[2]!);
    const entity = entityOf(attribute(match[1]!, "href"), name, dimension);
    if (entity && wanted.has(nameKey(name))) entries.set(entity.id, entity);
  }
  return [...entries.values()];
}
export function parseJavbusWorks(html: string, url: string, page: number): OnlineWorksPage {
  if (!isJavbusCatalogUrl(url) || !pageValid(page)) throw new Error("JavBus 分页参数无效。");
  const source = documentSource(html),
    items = new Map<string, OnlineWork>();
  const base = page === 1 ? url : url.replace(new RegExp(`/${page}$`), "");
  let nextPage: number | null = null,
    cards = 0,
    validCards = 0;
  for (const match of anchors(source)) {
    const target = sourceUrl(attribute(match[1]!, "href"), url);
    if (target?.href === `${base}/${page + 1}` && page < 1000) nextPage = page + 1;
    if (!hasClass(match[1]!, "movie-box")) continue;
    cards++;
    if (!target || !workPattern.test(target.pathname)) continue;
    const code = plain(/<date\b[^>]*>([^]*?)<\/date\s*>/i.exec(match[2]!)?.[1] ?? "");
    if (!code || normalizeCode(code) !== normalizeCode(pathCode(target))) continue;
    const img = /<img\b([^>]{0,4096})>/i.exec(match[2]!)?.[1] ?? "";
    const title = (attribute(img, "title") || attribute(img, "alt") || code).slice(0, 2000);
    const coverCandidates = imageUrls(img);
    items.set(target.href, {
      code,
      title,
      url: target.href,
      coverUrl: coverCandidates[0],
      coverCandidates,
    });
    validCards++;
    if (items.size > 100) throw new Error("JavBus 作品分页超过上限。");
  }
  if ((!items.size && !emptyResult(source)) || cards !== validCards || (!items.size && nextPage))
    throw new Error("未识别到完整 JavBus 作品列表，页面可能要求验证或结构已变化。");
  const summary = source.replace(
    /<a\b[^>]*class\s*=\s*["'][^"']*\b(?:movie-box|avatar-box)\b[^"']*["'][^>]*>[^]*?<\/a\s*>|<(nav|aside)\b[^>]*>[^]*?<\/\1\s*>/gi,
    "",
  );
  const total = readJavbusVideoCount(summary);
  return { items: [...items.values()], page, nextPage, ...(total === undefined ? {} : { total }) };
}

// 只读取显式影片总数。页数、当前页卡片数和作品标题里的数字都不是总数。
export function readJavbusVideoCount(source: string): number | undefined {
  const values = new Set<number>();
  const add = (raw: string) => {
    if (!/^(?:\d{1,3}(?:[,，]\d{3})+|\d+)$/.test(raw)) return;
    const count = Number(raw.replace(/[,，]/g, ""));
    if (Number.isSafeInteger(count) && count >= 0 && count <= 100_000_000) values.add(count);
  };
  for (const match of anchors(source)) {
    if (attribute(match[1]!, "id") !== "resultshowall") continue;
    const total = /^全部影片\s*([\d,，]+)$/.exec(plain(match[2]!));
    if (total) add(total[1]!);
  }
  for (const match of source.matchAll(
    /\bdata-(?:video|work|movie|total)-count\s*=\s*["']([\d,，]+)["']/gi,
  ))
    add(match[1]!);
  for (const match of source.matchAll(
    /<(?:span|div|p|strong|h[1-6])\b[^>]*class\s*=\s*["'][^"']*\b(?:video-count|work-count|movie-count|result-count|total-count)\b[^"']*["'][^>]*>([^]*?)<\/(?:span|div|p|strong|h[1-6])\s*>/gi,
  )) {
    const text = plain(match[1]!);
    if (/^[\d,，]+$/.test(text)) add(text);
  }
  const text = plain(source);
  for (const match of text.matchAll(
    /(?:影片數|影片数|作品數|作品数|視頻數|视频数)\s*[:：]?\s*([\d,，]+)|([\d,，]+)\s*部\s*(?:影片|作品|視頻|视频)|(?:total|found)\s*[:：]?\s*([\d,]+)\s*(?:movies|videos|works)/gi,
  ))
    add(match[1] ?? match[2] ?? match[3]!);
  return values.size === 1 ? values.values().next().value : undefined;
}
export function parseJavbusWorkDetails(html: string, work: OnlineWork): MovieDetails {
  const url = sourceUrl(work.url);
  if (!url || !workPattern.test(url.pathname)) throw new Error("JavBus 作品地址无效。");
  const source = documentSource(html),
    info = infoBlock(source);
  const lines = [...info.matchAll(/<p\b[^>]*>([^]*?)<\/p\s*>/gi)].map((m) => plain(m[1]!));
  const field = (pattern: RegExp) =>
    lines.map((line) => pattern.exec(line)?.[1]?.trim()).find(Boolean);
  const code = field(/^(?:識別碼|识别码|ID)\s*[:：]\s*(.+)$/i) ?? "";
  const title = plain(/<h3\b[^>]*>([^]*?)<\/h3\s*>/i.exec(source)?.[1] ?? "").slice(0, 2000);
  if (
    !code ||
    !title ||
    normalizeCode(code) !== normalizeCode(work.code) ||
    normalizeCode(code) !== normalizeCode(pathCode(url))
  )
    throw new Error("JavBus 作品详情身份不一致或未提供资料。");
  const relations = (route: string) => [
    ...new Set(
      anchors(info)
        .filter((m) => {
          const target = sourceUrl(attribute(m[1]!, "href"));
          return (
            target &&
            new RegExp(`^/(?:uncensored/)?${route}/[a-z0-9_-]{1,100}$`, "i").test(target.pathname)
          );
        })
        .map((m) => plain(m[2]!))
        .filter((name) => name && name.length <= 128),
    ),
  ];
  const cover = anchors(source).find((m) => hasClass(m[1]!, "bigImage"));
  const coverArea =
    cover?.[2] ??
    /<(div|span)\b[^>]*class\s*=\s*["'][^"']*\bbigImage\b[^"']*["'][^>]*>([^]*?)<\/\1\s*>/i.exec(
      source,
    )?.[2] ??
    "";
  const coverImg = /<img\b([^>]{0,4096})>/i.exec(coverArea)?.[1] ?? "";
  const coverCandidates = [
    ...new Set(
      [
        imageUrl(cover ? attribute(cover[1]!, "href") : ""),
        ...imageUrls(coverImg),
        work.coverUrl,
        ...(work.coverCandidates ?? []),
      ].filter((url): url is string => !!url),
    ),
  ].slice(0, 8);
  const date = field(/^(?:發行日期|发行日期|Release Date)\s*[:：]\s*(.+)$/i)?.match(
    /^\d{4}-\d{2}-\d{2}/,
  )?.[0];
  const minutes = Number.parseInt(field(/^(?:長度|长度|Length)\s*[:：]\s*(.+)$/i) ?? "", 10);
  return {
    provider: "JavBus",
    id: code,
    homepage: work.url,
    coverUrl: coverCandidates[0],
    coverCandidates,
    previewImages: previewImages(source, work.url),
    fields: {
      code,
      title,
      premiered: date,
      duration: Number.isFinite(minutes) && minutes > 0 && minutes <= 1440 ? minutes : undefined,
      actors: relations("star"),
      director: relations("director")[0],
      studio: relations("studio")[0],
      label: relations("label")[0],
      series: relations("series")[0],
      genres: relations("genre"),
    },
  };
}
