import type { ByteRange, PageResult, Playlist, Segment, Variant } from "./ports";
import type { ResolutionProvider } from "../../contracts/streamResolution";
import { bounds, ResolutionError, webUrl } from "./shared";

function text(body: ArrayBuffer, max: number) {
  if (body.byteLength > max) throw new ResolutionError("limit_exceeded");
  return new TextDecoder()
    .decode(body)
    .replace(/^\uFEFF/, "")
    .trim();
}
const quoted = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
function literal(value: string) {
  return value.slice(1, -1).replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[^])/gi, (_, escape: string) => {
    if (/^[ux]/i.test(escape)) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return (
      ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escape] ?? escape
    );
  });
}
/** 只还原已知 packer 的字符串字典，不执行 JavaScript。 */
function unpack(source: string) {
  const pattern = new RegExp(
    String.raw`\}\s*\(\s*(${quoted})\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(${quoted})\s*\.split\(\s*['"]\|['"]\s*\)`,
  );
  const match = pattern.exec(source);
  if (!match) throw new ResolutionError("parse_failed", true);
  const radix = Number(match[2]),
    count = Number(match[3]);
  if (radix < 2 || radix > 62 || count > 10_000) throw new ResolutionError("limit_exceeded");
  const payload = literal(match[1]!);
  const keys = literal(match[4]!).split("|");
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let cursor = 0,
    size = 0;
  const parts: string[] = [];
  for (const token of payload.matchAll(/\b[\da-zA-Z]+\b/g)) {
    let index = 0;
    for (const char of token[0]) {
      const digit = alphabet.indexOf(char);
      index = digit < radix ? index * radix + digit : Number.POSITIVE_INFINITY;
      if (index >= count) break;
    }
    const part =
      payload.slice(cursor, token.index) + (index < count && keys[index] ? keys[index] : token[0]);
    size += part.length;
    if (size > bounds.pageBytes) throw new ResolutionError("limit_exceeded");
    parts.push(part);
    cursor = token.index + token[0].length;
  }
  size += payload.length - cursor;
  if (size > bounds.pageBytes) throw new ResolutionError("limit_exceeded");
  return parts.join("") + payload.slice(cursor);
}
function entities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(
      /&#(?:x([a-f0-9]+)|(\d+));/gi,
      (_, hex: string | undefined, decimal: string | undefined) => {
        const code = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      },
    );
}
export function parsePage(
  body: ArrayBuffer,
  url: string,
  provider: ResolutionProvider,
): PageResult {
  let source = text(body, bounds.pageBytes);
  const candidates = new Set<string>();
  const next: PageResult["next"] = [];
  const add = (value: string, target?: ResolutionProvider) => {
    if (!value.trim()) return;
    let resolved: string;
    try {
      resolved = webUrl(entities(value), url);
    } catch {
      return;
    }
    if (target) {
      if (!next.some((item) => item.url === resolved) && next.length < 2)
        next.push({ url: resolved, provider: target });
    } else if (candidates.size < bounds.candidates) candidates.add(resolved);
  };
  const json = (raw: string) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ResolutionError("parse_failed", true);
    }
    const stack = [{ value, depth: 0 }];
    let visited = 0;
    while (stack.length) {
      if (++visited > 10_000) throw new ResolutionError("limit_exceeded");
      const current = stack.pop()!;
      if (!current.value || typeof current.value !== "object") continue;
      if (current.depth > 8) throw new ResolutionError("limit_exceeded");
      for (const [key, item] of Object.entries(current.value)) {
        if (key === "requiresInteraction" && item === true)
          throw new ResolutionError("interaction_required");
        if (typeof item === "string") {
          if (/^(hlsUrl|videoSrc|source|file|manifestUrl|playbackUrl|url)$/.test(key)) add(item);
          if (key === "apiUrl") add(item, "json-config");
          if (key === "embedUrl") add(item, "static-page");
        } else if (item && typeof item === "object")
          stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  };
  if (provider === "json-config") json(source);
  else {
    if (
      /data-resolution-state\s*=\s*["']interaction-required["']/i.test(source) ||
      /<input\b[^>]*\btype\s*=\s*["']password["']/i.test(source)
    )
      throw new ResolutionError("interaction_required");
    if (provider === "packed-script") source = unpack(source);
    const variables = new RegExp(
      String.raw`\b(?:hlsUrl|videoSrc|source|file|manifestUrl)\s*[:=]\s*(${quoted})`,
      "g",
    );
    for (const match of source.matchAll(variables)) add(literal(match[1]!));
    for (const match of source.matchAll(
      /<(video|source|iframe)\b[^>]*\bsrc\s*=\s*(["'])(.*?)\2[^>]*>/gi,
    ))
      add(match[3]!, match[1]!.toLowerCase() === "iframe" ? "static-page" : undefined);
    for (const match of source.matchAll(
      /<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ))
      json(match[1]!);
  }
  return { candidates: [...candidates], next };
}
function attrs(line: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/gy;
  let cursor = 0;
  while (cursor < line.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(line);
    if (!match || match[1]! in values) throw new ResolutionError("parse_failed", true);
    values[match[1]!] = match[2]!.replace(/^"|"$/g, "");
    cursor = pattern.lastIndex;
  }
  return values;
}
function range(
  raw: string | undefined,
  previous?: { url: string; range?: ByteRange },
  url = "",
): ByteRange | undefined {
  if (!raw) return;
  const match = /^(\d+)(?:@(\d+))?$/.exec(raw);
  if (!match) throw new ResolutionError("parse_failed", true);
  const length = Number(match[1]);
  const start =
    match[2] !== undefined
      ? Number(match[2])
      : previous?.url === url && previous.range
        ? previous.range.start + previous.range.length
        : -1;
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(start + length)
  )
    throw new ResolutionError("parse_failed", true);
  return { start, length };
}
export function parsePlaylist(body: ArrayBuffer, url: string): Playlist {
  const source = text(body, bounds.playlistBytes);
  const lines = source.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== "#EXTM3U") throw new ResolutionError("parse_failed", true);
  const variants: Variant[] = [],
    audio: Extract<Playlist, { kind: "master" }>["audio"] = [];
  let pending: Variant | undefined,
    duration = 0,
    partDuration: number | undefined;
  let targetDuration = 0,
    longest = 0;
  let first: Segment | undefined, previous: Segment | undefined, segmentRange: string | undefined;
  let key: string | undefined,
    iv = false,
    map: Segment["map"],
    gap = false,
    ended = false,
    segments = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      if (pending) throw new ResolutionError("parse_failed", true);
      const data = attrs(line.slice("#EXT-X-STREAM-INF:".length));
      const bandwidth = Number(data.BANDWIDTH);
      if (!Number.isSafeInteger(bandwidth) || bandwidth <= 0 || variants.length >= 64)
        throw new ResolutionError("limit_exceeded");
      const dimensions = /^(\d+)x(\d+)$/.exec(data.RESOLUTION ?? "");
      pending = {
        url: "",
        bandwidth,
        audio: data.AUDIO,
        width: dimensions ? Number(dimensions[1]) : undefined,
        height: dimensions ? Number(dimensions[2]) : undefined,
      };
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const data = attrs(line.slice(13));
      if (data.TYPE === "AUDIO") {
        if (!data["GROUP-ID"] || audio.length >= 64) throw new ResolutionError("limit_exceeded");
        audio.push({
          group: data["GROUP-ID"],
          url: data.URI ? webUrl(data.URI, url) : undefined,
          preferred: data.DEFAULT === "YES",
        });
      }
    } else if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
      const data = attrs(line.slice(line.indexOf(":") + 1));
      if (data.METHOD === "NONE") {
        key = undefined;
        iv = false;
      } else {
        if (data.METHOD !== "AES-128" || (data.KEYFORMAT && data.KEYFORMAT !== "identity"))
          throw new ResolutionError("unsupported_stream");
        if (!data.URI) throw new ResolutionError("parse_failed", true);
        key = webUrl(data.URI, url);
        iv = /^0x[\da-f]{32}$/i.test(data.IV ?? "");
        if (data.IV && !iv) throw new ResolutionError("parse_failed", true);
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const data = attrs(line.slice(11));
      if (!data.URI || (key && !iv)) throw new ResolutionError("unsupported_stream");
      const mapUrl = webUrl(data.URI, url);
      map = { url: mapUrl, range: range(data.BYTERANGE, map, mapUrl), key };
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      if (targetDuration) throw new ResolutionError("parse_failed", true);
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length));
      if (!Number.isSafeInteger(targetDuration) || targetDuration <= 0)
        throw new ResolutionError("parse_failed", true);
    } else if (line.startsWith("#EXTINF:")) {
      if (partDuration !== undefined) throw new ResolutionError("parse_failed", true);
      partDuration = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(partDuration) || partDuration < 0)
        throw new ResolutionError("parse_failed", true);
    } else if (line.startsWith("#EXT-X-BYTERANGE:"))
      segmentRange = line.slice("#EXT-X-BYTERANGE:".length);
    else if (line.startsWith("#EXT-X-DEFINE:") || line === "#EXT-X-I-FRAMES-ONLY")
      throw new ResolutionError("unsupported_stream");
    else if (line === "#EXT-X-GAP") gap = true;
    else if (line === "#EXT-X-ENDLIST") ended = true;
    else if (line && !line.startsWith("#")) {
      const resolved = webUrl(line, url);
      if (pending) {
        variants.push({ ...pending, url: resolved });
        pending = undefined;
      } else {
        if (partDuration === undefined || ++segments > 50_000)
          throw new ResolutionError("parse_failed", true);
        const segment: Segment = {
          url: resolved,
          range: range(segmentRange, previous, resolved),
          key,
          map,
        };
        if (!first && !gap) first = segment;
        previous = segment;
        duration += partDuration;
        longest = Math.max(longest, Math.round(partDuration));
        partDuration = undefined;
        segmentRange = undefined;
        gap = false;
      }
    }
  }
  if (pending || partDuration !== undefined || (variants.length && segments))
    throw new ResolutionError("parse_failed", true);
  if (variants.length) {
    if (targetDuration || ended) throw new ResolutionError("parse_failed", true);
    return { kind: "master", variants: variants.sort((a, b) => b.bandwidth - a.bandwidth), audio };
  }
  if (!ended) throw new ResolutionError("unsupported_stream");
  if (
    !first ||
    duration <= 0 ||
    !Number.isFinite(duration) ||
    !targetDuration ||
    longest > targetDuration
  )
    throw new ResolutionError("parse_failed", true);
  return { kind: "media", duration, first };
}
