import type { Store } from "../metadata/shared";
import type { ResolutionHttpPort } from "../streamResolution/ports";
import { ResolutionError } from "../streamResolution/shared";
import { logEvent } from "../logging/events";

export const updateCacheMs = 15 * 60 * 1000;
export const updateRequestMs = 20_000;
const maxEntries = 24,
  maxCacheBytes = 3 * 1024 * 1024;
type Entry = { url: string; body: string; fetchedAt: number; etag?: string; modified?: string };
type Cooldown = { origin: string; until: number; failures: number; limited: boolean };
type UpdateHttpPort = (
  request: Omit<Parameters<ResolutionHttpPort>[0], "proxy">,
  signal: AbortSignal,
) => ReturnType<ResolutionHttpPort>;
export interface UpdateHttpState {
  entries: Entry[];
  cooldowns: Cooldown[];
}
export class UpdateCheckDeferredError extends Error {
  constructor(
    readonly retryAt: number,
    limited: boolean,
  ) {
    super(
      limited
        ? "更新服务暂时限流，已暂停请求；可稍后重试或切换镜像。"
        : "更新服务暂时不可用，已暂停请求；可稍后重试或切换镜像。",
    );
  }
}
export class UpdateHttp {
  private cache = new Map<string, Entry>();
  private cooldowns = new Map<string, Cooldown>();
  private loading?: Promise<void>;
  constructor(
    private http: UpdateHttpPort,
    private store: Store<UpdateHttpState>,
    private now = Date.now,
  ) {}
  private initialize() {
    return (this.loading ??= (async () => {
      try {
        const saved = (await this.store.read()) as Partial<UpdateHttpState> | null;
        if (!saved || !Array.isArray(saved.entries) || !Array.isArray(saved.cooldowns)) return;
        for (const entry of saved.entries.slice(-12)) {
          if (
            entry &&
            typeof entry.url === "string" &&
            typeof entry.body === "string" &&
            entry.body.length <= 65536 &&
            Number.isFinite(entry.fetchedAt) &&
            entry.fetchedAt <= this.now() &&
            this.now() - entry.fetchedAt < 86400000 &&
            typeof entry.etag !== "object" &&
            typeof entry.modified !== "object"
          ) {
            try {
              this.validateUrl(entry.url);
              JSON.parse(entry.body);
              this.cache.set(entry.url, {
                ...entry,
                etag: safeValidator(entry.etag),
                modified: safeValidator(entry.modified),
              });
            } catch {
              this.warn();
            }
          }
        }
        for (const value of saved.cooldowns.slice(-8)) {
          if (
            value &&
            typeof value.origin === "string" &&
            /^https:\/\/[^/?#@]+$/.test(value.origin) &&
            Number.isFinite(value.until) &&
            value.until > this.now() &&
            value.until <= this.now() + 86400000 &&
            Number.isInteger(value.failures) &&
            value.failures >= 1 &&
            value.failures <= 8 &&
            typeof value.limited === "boolean"
          )
            this.cooldowns.set(value.origin, value);
        }
      } catch {
        this.warn();
      }
    })());
  }
  private warn() {
    logEvent("warn", "update", "cache_unavailable", "更新缓存读写失败，将在当前会话继续检查");
  }
  private async save() {
    try {
      await this.store.write({
        entries: [...this.cache.values()]
          .filter((entry) => entry.url.endsWith("/JAVM-update.json") && entry.body.length <= 65536)
          .slice(-12),
        cooldowns: [...this.cooldowns.values()]
          .filter((entry) => entry.until > this.now())
          .slice(-8),
      });
    } catch {
      this.warn();
    }
  }
  private validateUrl(url: string) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || target.port)
      throw new Error("更新请求地址无效。");
    return target;
  }
  private remember(entry: Entry) {
    this.cache.delete(entry.url);
    this.cache.set(entry.url, entry);
    let bytes = [...this.cache.values()].reduce((total, value) => total + value.body.length * 2, 0);
    while (this.cache.size > maxEntries || bytes > maxCacheBytes) {
      const first = this.cache.values().next().value!;
      bytes -= first.body.length * 2;
      this.cache.delete(first.url);
    }
  }
  async discard(url: string) {
    this.cache.delete(url);
    await this.save();
  }
  private async defer(origin: string, limited: boolean, headers: Record<string, string> = {}) {
    const failures = Math.min(8, (this.cooldowns.get(origin)?.failures ?? 0) + 1);
    const now = this.now();
    const retry = headers["retry-after"]?.trim();
    const after = retry
      ? /^\d+$/.test(retry)
        ? now + Number(retry) * 1000
        : Date.parse(retry)
      : 0;
    const reset = Number(headers["x-ratelimit-reset"]) * 1000;
    const until = Math.min(
      now + 86400000,
      Math.max(
        now + Math.min(3600000, 30000 * 2 ** (failures - 1)),
        Number.isFinite(after) ? after : 0,
        Number.isFinite(reset) ? reset : 0,
      ),
    );
    this.cooldowns.set(origin, { origin, until, failures, limited });
    while (this.cooldowns.size > 8) this.cooldowns.delete(this.cooldowns.keys().next().value!);
    await this.save();
    return new UpdateCheckDeferredError(until, limited);
  }
  async json(original: string, signal: AbortSignal): Promise<unknown> {
    await this.initialize();
    signal.throwIfAborted();
    const origin = this.validateUrl(original).origin;
    const cached = this.cache.get(original);
    if (cached && this.now() - cached.fetchedAt < updateCacheMs && this.now() >= cached.fetchedAt) {
      logEvent("debug", "update", "cache_hit", "复用更新元数据缓存", {}, { requestUrl: original });
      return JSON.parse(cached.body);
    }
    const cooldown = this.cooldowns.get(origin);
    if (cooldown && cooldown.until > this.now())
      throw new UpdateCheckDeferredError(cooldown.until, cooldown.limited);
    let url = original;
    for (let hop = 0; hop < 6; hop++) {
      this.validateUrl(url);
      const response = await this.http(
        {
          url,
          headers: {
            Accept: "application/json",
            ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
            ...(cached?.modified ? { "If-Modified-Since": cached.modified } : {}),
          },
          maxBytes: 1024 * 1024,
          timeoutMs: updateRequestMs,
        },
        signal,
      ).catch(async (error: unknown) => {
        signal.throwIfAborted();
        if (error instanceof ResolutionError) {
          if (error.code === "limit_exceeded")
            throw new Error("更新信息超过大小限制，请前往官方发布页面检查更新。");
          await this.defer(origin, false);
          throw new Error(
            error.code === "timeout"
              ? "检查更新超时，请检查网络或代理后重试。"
              : "检查更新请求失败，请检查网络或代理后重试。",
            { cause: error },
          );
        }
        throw error;
      });
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        url = new URL(response.headers.location, url).href;
        continue;
      }
      const body = new TextDecoder().decode(response.body);
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers["x-ratelimit-remaining"] === "0" ||
            !!response.headers["retry-after"] ||
            /(?:rate limit|secondary rate)/i.test(body)));
      if (limited || response.status >= 500)
        throw await this.defer(origin, limited, response.headers);
      if (response.status === 304 && cached) {
        this.remember({ ...cached, fetchedAt: this.now() });
        this.cooldowns.delete(origin);
        await this.save();
        return JSON.parse(cached.body);
      }
      if (response.status !== 200) throw new Error(`更新检查失败（HTTP ${response.status}）。`);
      const value: unknown = JSON.parse(body);
      this.remember({
        url: original,
        body,
        fetchedAt: this.now(),
        etag: safeValidator(response.headers.etag),
        modified: safeValidator(response.headers["last-modified"]),
      });
      this.cooldowns.delete(origin);
      await this.save();
      return value;
    }
    throw new Error("更新请求重定向过多。");
  }
}
function safeValidator(value: unknown) {
  return typeof value === "string" && value.length <= 512 && !/[\r\n]/.test(value)
    ? value
    : undefined;
}
