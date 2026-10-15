import type { ResolutionRequest } from "../../contracts/streamResolution";
import type { ByteRange, ResolutionHttpPort } from "./ports";
import { StopUnconfirmedError } from "../downloads/ports";
import { bounds, check, ResolutionError, webUrl } from "./shared";

export class ResolutionHttpSession {
  private requests = 0;
  private useProxy = false;
  readonly origin: string;
  constructor(
    readonly request: ResolutionRequest,
    private readonly port: ResolutionHttpPort,
    private readonly proxy: string,
    private readonly deadline: number,
    private readonly signal: AbortSignal,
    private readonly progress: (requests: number) => void,
  ) {
    this.origin = new URL(request.url).origin;
    this.useProxy = !!request.preferProxy && !!proxy;
  }

  async get(input: string, maxBytes: number, range?: ByteRange) {
    let url = webUrl(input);
    const seen = new Set<string>();
    let redirects = 0;
    while (true) {
      check(this.signal);
      if (seen.has(url)) throw new ResolutionError("parse_failed", true);
      seen.add(url);
      let response: Awaited<ReturnType<ResolutionHttpPort>>;
      while (true) {
        const remaining = this.deadline - Date.now();
        if (remaining <= 0) throw new ResolutionError("timeout");
        if (++this.requests > bounds.requests) throw new ResolutionError("limit_exceeded");
        this.progress(this.requests);
        // 所有调用方请求头按精确 origin 隔离，包括自定义令牌和 Referer。
        const headers = {
          ...this.request.publicHeaders,
          ...(new URL(url).origin === this.origin ? this.request.headers : {}),
        };
        const abort = new AbortController();
        const cancel = () => abort.abort(this.signal.reason);
        this.signal.addEventListener("abort", cancel, { once: true });
        const timeoutMs = Math.min(bounds.requestMs, remaining);
        const timer = setTimeout(() => abort.abort(new ResolutionError("timeout")), timeoutMs);
        try {
          response = await this.port(
            { url, headers, range, maxBytes, timeoutMs, proxy: this.useProxy ? this.proxy : "" },
            abort.signal,
          );
          check(this.signal);
          check(abort.signal);
          break;
        } catch (error) {
          if (error instanceof StopUnconfirmedError) throw error;
          check(this.signal);
          const problem =
            error instanceof ResolutionError ? error : new ResolutionError("network_error");
          if (!this.useProxy && this.proxy && ["network_error", "timeout"].includes(problem.code)) {
            this.useProxy = true;
          } else throw problem;
        } finally {
          clearTimeout(timer);
          this.signal.removeEventListener("abort", cancel);
        }
      }
      const headers = Object.fromEntries(
        Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      if (response.body.byteLength > maxBytes) throw new ResolutionError("limit_exceeded");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!headers.location || ++redirects > bounds.redirects)
          throw new ResolutionError("limit_exceeded");
        const next = webUrl(headers.location, url);
        if (new URL(url).protocol === "https:" && new URL(next).protocol !== "https:")
          throw new ResolutionError("invalid_input");
        url = next;
        continue;
      }
      if (response.status === 401) throw new ResolutionError("session_required");
      if (response.status === 403) throw new ResolutionError("parse_failed", true);
      if (response.status === 429) throw new ResolutionError("rate_limited");
      if ([404, 410].includes(response.status)) throw new ResolutionError("not_found");
      if (![200, 206].includes(response.status)) throw new ResolutionError("network_error");
      if (headers["content-encoding"] && headers["content-encoding"].toLowerCase() !== "identity")
        throw new ResolutionError("unsupported_stream");
      if (range) {
        if (response.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(headers["content-range"] ?? "");
          if (!match) throw new ResolutionError("parse_failed", true);
          const start = Number(match[1]),
            end = Number(match[2]);
          if (
            start !== range.start ||
            end < start ||
            end >= start + range.length ||
            end - start + 1 !== response.body.byteLength ||
            (end < start + range.length - 1 && Number(match[3]) !== end + 1)
          )
            throw new ResolutionError("parse_failed", true);
        } else if (range.start !== 0) throw new ResolutionError("parse_failed", true);
      } else if (response.status !== 200) throw new ResolutionError("parse_failed", true);
      return { ...response, headers, url };
    }
  }
}
