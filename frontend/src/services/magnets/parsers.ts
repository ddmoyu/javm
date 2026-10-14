import { normalizeMagnet, mergeMagnets } from "./magnet";
import { magnetLimits } from "./types";
import type { MagnetPage, MagnetResource, MagnetSourceId } from "./types";
import { ResolutionError } from "../streamResolution/shared";

function entities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (whole, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    },
  );
}
const plain = (value: string) =>
  entities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
function attribute(tag: string, name: string) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    tag,
  );
  return match ? entities(match[1] ?? match[2] ?? match[3] ?? "") : "";
}
const hasClass = (tag: string, name: string) => attribute(tag, "class").split(/\s+/).includes(name);
function element(block: string, tag: string, className?: string) {
  for (const match of block.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))) {
    if (className && !hasClass(match[0], className)) continue;
    const from = match.index + match[0].length;
    const end = block.toLowerCase().indexOf(`</${tag}>`, from);
    return end < 0 ? "" : block.slice(from, end);
  }
  return "";
}
function sizeOf(value: string) {
  const match = /([\d]+(?:[.,]\d+)?)\s*(B|[KMGT]i?B)\b/i.exec(value);
  if (!match) return;
  const unit = match[2]!.toUpperCase();
  const power = unit === "B" ? 0 : "KMGT".indexOf(unit[0]!) + 1;
  const size = Math.round(Number(match[1]!.replace(",", ".")) * 1024 ** power);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}
function countOf(value: string) {
  const match = /\d[\d,]*/.exec(value);
  if (!match) return;
  const count = Number(match[0].replaceAll(",", ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** 只在隔离 Worker 里解析有界文本，不加载网页、图片或执行脚本。 */
export function parseMagnetPage(
  body: ArrayBuffer,
  url: string,
  source: MagnetSourceId,
): MagnetPage {
  if (body.byteLength > magnetLimits.bytes) throw new ResolutionError("limit_exceeded");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const html = text.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
  const tag = source === "btdig" ? "div" : "article";
  const marker = source === "btdig" ? "one_result" : "item";
  const starts: number[] = [];
  for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))) {
    if (hasClass(match[0], marker)) starts.push(match.index);
    if (starts.length > magnetLimits.pageRows) break;
  }
  const rows: MagnetResource[] = [];
  // 有真实结果结构时，标题或查询中的 captcha 等关键词不构成验证页证据。
  if (
    !starts.length &&
    /cf-chl-|cf-turnstile|captcha|verify you are human|just a moment|人机验证/i.test(text)
  )
    throw new ResolutionError("interaction_required");
  for (let index = 0; index < Math.min(starts.length, magnetLimits.pageRows); index++) {
    const block = html.slice(
      starts[index],
      Math.min(starts[index + 1] ?? html.length, starts[index]! + 128 * 1024),
    );
    const title = plain(
      source === "btdig"
        ? element(block, "div", "torrent_name")
        : element(block, "h4").replace(/<span\b[^>]*>[^]*?<\/span>/gi, ""),
    ).slice(0, 500);
    if (!title) continue;
    let raw = "";
    for (const anchor of block.matchAll(/<a\b[^>]*>/gi)) {
      const href = attribute(anchor[0], "href");
      if (source === "btdig" && href.startsWith("magnet:?")) {
        raw = href;
        break;
      }
      if (source === "btdirectory") {
        const hash = /^\/hash\/([a-f\d]{40})(?:\.html)?(?:[/?#]|$)/i.exec(href);
        if (hash) {
          raw = `magnet:?xt=urn:btih:${hash[1]}&dn=${encodeURIComponent(title)}`;
          break;
        }
      }
    }
    const magnet = normalizeMagnet(raw);
    if (!magnet) continue;
    const info = plain(element(block, "p"));
    const size =
      source === "btdig"
        ? plain(element(block, "span", "torrent_size"))
        : (/Size\s*[:：]\s*([\d.,]+\s*[KMGT]?i?B)/i.exec(info)?.[1] ?? "");
    const files =
      source === "btdig"
        ? plain(element(block, "span", "torrent_files"))
        : (/File Count\s*[:：]\s*([\d,]+)/i.exec(info)?.[1] ?? "");
    const date =
      source === "btdig"
        ? plain(element(block, "span", "torrent_age"))
        : /\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?/.exec(info)?.[0];
    rows.push({
      ...magnet,
      title,
      sizeBytes: sizeOf(size),
      files: countOf(files),
      date: date?.slice(0, 80),
      sources: [source],
    });
  }
  if (starts.length && !rows.length) throw new ResolutionError("parse_failed");
  if (
    !starts.length &&
    !/\b0 results|no (?:results|torrents|matches)|not found|没有找到|未找到|暂无结果|无搜索结果|没有搜索到/i.test(
      plain(html),
    )
  )
    throw new ResolutionError("parse_failed");
  let hasMore = false;
  if (source === "btdig") {
    const current = new URL(url);
    const page = Number(current.searchParams.get("p") ?? 0);
    for (const anchor of html.matchAll(/<a\b[^>]*>/gi)) {
      try {
        const next = new URL(attribute(anchor[0], "href"), current);
        if (
          next.origin === current.origin &&
          next.pathname === current.pathname &&
          next.searchParams.get("q") === current.searchParams.get("q") &&
          Number(next.searchParams.get("p")) === page + 1
        )
          hasMore = true;
      } catch {
        /* 非搜索分页链接忽略。 */
      }
    }
  }
  return { rows: mergeMagnets([], rows), hasMore };
}
