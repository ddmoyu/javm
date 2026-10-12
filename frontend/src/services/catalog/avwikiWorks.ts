import type { MovieDetails } from "../metadata/MetaTubeService";
import { normalizeCode } from "../scraping/identity";
import { avwikiSources, hasControlCharacters } from "./avwikiCsv";
import type { AvwikiDimension, AvwikiEntry } from "./avwikiCsv";

export interface AvwikiEntity {
  id: string;
  name: string;
  url: string;
}
export interface AvwikiWork {
  code: string;
  title: string;
  url: string;
  coverUrl?: string;
  coverCandidates?: string[];
}
export interface AvwikiWorksPage {
  items: AvwikiWork[];
  page: number;
  nextPage: number | null;
  total?: number;
}
const origin = "https://avwikidb.com";
const validId = (id: string) => /^[a-z]?\d{1,16}$/.test(id);
export function avwikiEntityUrl(dimension: AvwikiDimension, id: string, page = 1) {
  if (
    !Object.hasOwn(avwikiSources, dimension) ||
    !validId(id) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1000
  )
    throw new Error("作品目录地址无效。");
  return `${avwikiSources[dimension]}${id}/${page === 1 ? "" : `?page=${page}`}`;
}
export function isAvwikiWorksUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ((/^\/(?:actor|histrion|director|maker|series)\/[a-z]?\d{1,16}\/$/.test(url.pathname) &&
        (!url.search || /^\?page=(?:[1-9]\d{0,2}|1000)$/.test(url.search))) ||
        (/^\/work\/[a-z0-9][a-z0-9_-]{0,79}\/$/i.test(url.pathname) && !url.search))
    );
  } catch {
    return false;
  }
}
export function resolveAvwikiEntities(
  entries: AvwikiEntry[],
  dimension: AvwikiDimension,
  name: string,
  additions: Record<string, string> = {},
): AvwikiEntity[] {
  // 原名、已维护译名或明确别名才可定位；同名的多个来源身份交给用户选择。
  const matches = new Map<string, string>();
  for (const entry of entries) {
    const currentName = additions[entry.id] ?? entry.name;
    if (currentName === name || entry.label === name || entry.aliases.includes(name))
      matches.set(entry.id, currentName);
  }
  for (const [id, currentName] of Object.entries(additions))
    if (currentName === name) matches.set(id, currentName);
  if (matches.size > 50) throw new Error("同名来源过多，请先在名称管理中确认身份。");
  return [...matches].map(([id, currentName]) => ({
    id,
    name: currentName,
    url: avwikiEntityUrl(dimension, id),
  }));
}

function decode(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const known: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&nbsp;": " ",
    };
    if (known[entity.toLowerCase()]) return known[entity.toLowerCase()]!;
    const code = Number.parseInt(
      entity.slice(entity[2]?.toLowerCase() === "x" ? 3 : 2, -1),
      entity[2]?.toLowerCase() === "x" ? 16 : 10,
    );
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : "";
  });
}
const plain = (value: string) =>
  decode(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
function attribute(attrs: string, name: string) {
  return decode(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([^]*?)\\1`, "i").exec(attrs)?.[2] ?? "",
  );
}
function documentSource(html: string) {
  if (!html || html.length > 2 * 1024 * 1024) throw new Error("作品页面为空或超过大小限制。");
  return html.replace(/<!--[^]*?-->|<(script|style|template|aside)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
}
function imageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || hasControlCharacters(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    /* 非网络图片保留占位。 */
  }
}
function workUrl(value: string): URL | undefined {
  try {
    const url = new URL(value, origin);
    if (url.pathname.startsWith("/work/") && !url.pathname.endsWith("/")) url.pathname += "/";
    if (isAvwikiWorksUrl(url.href) && url.pathname.startsWith("/work/")) return url;
  } catch {
    /* 忽略无效链接。 */
  }
}

// 只读取主内容里的 /work/ 链接，不执行页面脚本、加载图片或追踪外部导航。
export function parseAvwikiWorks(
  html: string,
  entity: AvwikiEntity,
  page: number,
): AvwikiWorksPage {
  if (
    !isAvwikiWorksUrl(entity.url) ||
    entity.url.includes("/work/") ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1000
  )
    throw new Error("作品目录参数无效。");
  const source = documentSource(html);
  const main = /<main\b[^>]*>([^]*?)<\/main\s*>/i.exec(source)?.[1];
  if (!main) throw new Error("来源未返回作品列表，请重试。");
  const items = new Map<string, AvwikiWork>();
  let nextPage: number | null = null;
  for (const match of main.matchAll(/<a\b([^>]{0,4096})>([^]*?)<\/a\s*>/gi)) {
    const href = attribute(match[1]!, "href");
    if (!href || match[2]!.length > 64 * 1024) continue;
    const url = workUrl(href);
    if (url) {
      const code = url.pathname.split("/")[2]!.toUpperCase();
      const body = match[2]!;
      const img = /<img\b([^>]{0,4096})>/i.exec(body)?.[1] ?? "";
      const heading = /<h[2-4]\b[^>]*>([^]*?)<\/h[2-4]\s*>/i.exec(body)?.[1];
      const title =
        (heading
          ? plain(heading)
          : attribute(img, "alt") || attribute(match[1]!, "title") || plain(body)
        ).slice(0, 2000) || code;
      const previous = items.get(url.href);
      items.set(url.href, {
        code,
        title: previous && previous.title !== code ? previous.title : title,
        url: url.href,
        coverUrl: previous?.coverUrl ?? imageUrl(attribute(img, "src")),
      });
      if (items.size > 100) throw new Error("来源作品分页超过上限，请重试。");
    } else {
      try {
        const next = new URL(href, entity.url);
        if (
          next.origin === origin &&
          next.pathname === new URL(entity.url).pathname &&
          !next.username &&
          !next.password &&
          !next.hash &&
          next.search === `?page=${page + 1}`
        )
          nextPage = page + 1;
      } catch {
        /* 无关导航不参与分页。 */
      }
    }
  }
  const text = plain(main);
  const totalText = /全\s*([\d,]+)\s*件/.exec(text)?.[1];
  const total = totalText === undefined ? undefined : Number(totalText.replaceAll(",", ""));
  if (
    !items.size &&
    total !== 0 &&
    !/作品.{0,12}(見つかりません|ありません)|該当.{0,16}ありません/.test(text)
  )
    throw new Error("未识别到作品结果，页面可能要求验证或结构已变化。");
  if (!items.size && nextPage) throw new Error("作品分页内容不完整，请重试。");
  if (page === 1000 && nextPage) throw new Error("作品页数超过上限。");
  return { items: [...items.values()], page, nextPage, ...(total === undefined ? {} : { total }) };
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const string = (value: unknown, max = 2000) =>
  typeof value === "string"
    ? value
        .replace(/\p{Cc}/gu, (char) => ("\t\n\r".includes(char) ? char : ""))
        .trim()
        .slice(0, max)
    : "";
function names(value: unknown, key: string) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : value ? [value] : [])
        .slice(0, 100)
        .map((item) =>
          typeof item === "string"
            ? string(item, 128)
            : string(record(item).name ?? record(record(item)[key]).name, 128),
        )
        .filter(Boolean),
    ),
  ];
}
export function parseAvwikiWorkDetails(html: string, work: AvwikiWork): MovieDetails {
  documentSource(html);
  let payload: RecordValue = {};
  for (const match of html.matchAll(/<script\b([^>]{0,4096})>([^]*?)<\/script\s*>/gi))
    if (attribute(match[1]!, "id") === "__NEXT_DATA__") {
      try {
        payload = record(JSON.parse(match[2]!));
      } catch {
        throw new Error("作品详情数据无效，请重试。");
      }
      break;
    }
  const props = record(record(payload.props).pageProps);
  const movie = record(props.movie),
    dmm = record(props.dmmData),
    info = record(dmm.iteminfo);
  const code = string(movie.adultVideoId, 80);
  const title = string(movie.title) || string(dmm.title);
  if (!code || !title || normalizeCode(code) !== normalizeCode(work.code))
    throw new Error("作品详情身份不一致或未提供资料，请重试。");
  const date = string(movie.dateOfPublication || dmm.date).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const duration = Number.parseInt(string(dmm.volume), 10);
  const coverUrl = imageUrl(movie.imageL) ?? imageUrl(record(dmm.imageURL).large);
  const relation = (key: string, fallback = key) => {
    const primary = names(movie[key], key);
    return primary.length ? primary : names(info[fallback], fallback);
  };
  return {
    provider: "AVWikiDB",
    id: work.code,
    homepage: work.url,
    coverUrl,
    fields: {
      code,
      title,
      plot: string(movie.summary || info.description, 16000),
      premiered: date,
      duration:
        Number.isFinite(duration) && duration > 0 && duration <= 1440 ? duration : undefined,
      actors: [...new Set([...relation("actor", "actress"), ...relation("histrion")])],
      director: relation("director")[0],
      studio: relation("maker")[0],
      label: relation("label")[0],
      series: relation("series")[0],
      genres: relation("genre"),
    },
  };
}
