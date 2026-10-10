import type {
  ResolutionRequest,
  ResolvedStream,
  ResolvedTrack,
} from "../../contracts/streamResolution";
import type { ByteRange, ResolutionParser, Segment, Variant } from "./ports";
import type { ResolutionHttpSession } from "./http";
import { bounds, check, ResolutionError } from "./shared";

// 单个候选失败可尝试下一项；全局预算、会话、取消和清理问题必须立即停止。
function canTryAnother(error: unknown) {
  return (
    error instanceof ResolutionError &&
    ["not_found", "parse_failed", "unsupported_stream"].includes(error.code)
  );
}

class HlsValidator {
  private keys = new Set<string>();
  constructor(
    private readonly http: ResolutionHttpSession,
    private readonly parser: ResolutionParser,
    private readonly signal: AbortSignal,
  ) {}
  private async sample(url: string, limit: number, range?: ByteRange) {
    const size = Math.min(range?.length ?? limit, limit);
    const response = await this.http.get(url, size, { start: range?.start ?? 0, length: size });
    const prefix = new TextDecoder().decode(response.body.slice(0, 256)).trimStart();
    if (
      !response.body.byteLength ||
      (range && response.body.byteLength !== size) ||
      /^<(?:!doctype|html|head|body|\?xml|error)\b/i.test(prefix) ||
      /(?:text\/html|application\/json)/i.test(response.headers["content-type"] ?? "")
    )
      throw new ResolutionError("parse_failed", true);
  }
  private async key(url?: string) {
    if (!url || this.keys.has(url)) return;
    const response = await this.http.get(url, 16);
    if (response.body.byteLength !== 16) throw new ResolutionError("parse_failed", true);
    this.keys.add(url);
  }
  private async probe(segment: Segment) {
    if (segment.map) {
      await this.key(segment.map.key);
      await this.sample(segment.map.url, 256 * 1024, segment.map.range);
    }
    await this.key(segment.key);
    await this.sample(segment.url, 64 * 1024, segment.range);
  }
  async validate(
    url: string,
    kind: "video" | "audio" = "video",
    ancestors = new Set<string>(),
  ): Promise<{ manifestUrl: string; tracks: ResolvedTrack[] }> {
    check(this.signal);
    if (ancestors.size >= 3 || ancestors.has(url)) throw new ResolutionError("parse_failed", true);
    const response = await this.http.get(url, bounds.playlistBytes);
    if (ancestors.has(response.url)) throw new ResolutionError("parse_failed", true);
    const path = new Set([...ancestors, response.url]);
    const playlist = await this.parser.run(
      "playlist",
      { url: response.url, body: response.body },
      this.signal,
    );
    check(this.signal);
    if (playlist.kind === "media") {
      await this.probe(playlist.first);
      return {
        manifestUrl: response.url,
        tracks: [{ kind, url: response.url, duration: playlist.duration }],
      };
    }
    let last: unknown = new ResolutionError("parse_failed", true);
    for (const variant of playlist.variants.slice(0, 3)) {
      try {
        const child = await this.validate(variant.url, kind, path);
        const tracks = child.tracks.map((track) =>
          track.kind === kind ? { ...track, ...this.quality(variant) } : track,
        );
        if (variant.audio) {
          if (kind === "audio") throw new ResolutionError("unsupported_stream");
          const group = playlist.audio.filter((item) => item.group === variant.audio);
          const audio = group.find((item) => item.preferred) ?? group[0];
          if (!audio) throw new ResolutionError("parse_failed", true);
          if (audio.url) {
            if (tracks.some((track) => track.kind === "audio"))
              throw new ResolutionError("unsupported_stream");
            tracks.push(...(await this.validate(audio.url, "audio", path)).tracks);
          }
        }
        return { manifestUrl: response.url, tracks };
      } catch (error) {
        if (!canTryAnother(error)) throw error;
        last = error;
      }
    }
    throw last;
  }
  private quality(variant: Variant) {
    return { bandwidth: variant.bandwidth, width: variant.width, height: variant.height };
  }
}

export async function resolveHttp(
  request: ResolutionRequest,
  http: ResolutionHttpSession,
  parser: ResolutionParser,
  signal: AbortSignal,
  progress: (state: "http" | "validating", found: number) => void,
): Promise<ResolvedStream[]> {
  const candidates = new Set<string>();
  const pages: { url: string; provider: ResolutionRequest["provider"]; depth: number }[] = [
    { ...request, depth: 0 },
  ];
  const visited = new Set<string>();
  const validator = new HlsValidator(http, parser, signal);
  let last: unknown = new ResolutionError("parse_failed", true);
  let validated = 0;
  while (pages.length && validated < 3) {
    check(signal);
    const page = pages.shift()!;
    if (visited.has(page.url)) continue;
    visited.add(page.url);
    let discovered = [page.url];
    if (page.provider !== "direct-hls") {
      progress("http", candidates.size);
      try {
        const response = await http.get(page.url, bounds.pageBytes);
        const result = await parser.run(
          "page",
          { url: response.url, provider: page.provider, body: response.body },
          signal,
        );
        discovered = result.candidates;
        if (page.depth < 2)
          for (const next of result.next) pages.push({ ...next, depth: page.depth + 1 });
      } catch (error) {
        if (!canTryAnother(error) || page.depth === 0) throw error;
        last = error;
        continue;
      }
    }
    for (const candidate of discovered) {
      check(signal);
      if (candidates.has(candidate)) continue;
      if (validated >= 3 || candidates.size >= bounds.candidates) break;
      candidates.add(candidate);
      validated++;
      progress("validating", candidates.size);
      try {
        const result = await validator.validate(candidate);
        check(signal);
        const checkedAt = Date.now();
        // 先检查当前页候选，成功即结束，避免无关 iframe 让有效结果失败。
        return [
          {
            ...result,
            pageUrl: request.url,
            discoveredBy: "http",
            validation: "playlist-and-sample",
            checkedAt,
            expiresAt: checkedAt + 60_000,
            context: {
              origin: http.origin,
              headers: { ...request.headers },
              publicHeaders: { ...request.publicHeaders },
              preferProxy: request.preferProxy,
            },
          },
        ];
      } catch (error) {
        if (!canTryAnother(error)) throw error;
        last = error;
      }
    }
  }
  throw last;
}
