import type { MovieDetails } from "../metadata/MetaTubeService";
import { StopUnconfirmedError } from "../downloads/ports";
import { normalizeCode } from "../streamResolution/sources";
import { JAVBUS_ORIGIN } from "./javbusWorks";
import type { CatalogProcessor } from "./workerClient";
import { MovieDetailsCache } from "../metadata/MovieDetailsCache";

/** 精确番号后备查询；只读两个作品地址，不采集目录或预取关联作品。 */
export class JavbusMovieLookup {
  private active?: { abort: AbortController; done: Promise<MovieDetails> };
  private cleanup?: () => Promise<void>;
  private stopped = false;
  readonly available: boolean;
  constructor(
    private processor: CatalogProcessor,
    private fetch?: (url: string, signal: AbortSignal) => Promise<string>,
    private cache = new MovieDetailsCache(),
  ) {
    this.available = !!fetch;
  }
  async read(input: string, signal: AbortSignal): Promise<MovieDetails> {
    signal.throwIfAborted();
    if (this.stopped || !this.fetch) throw new Error("影片资料查询暂不可用。");
    const code = normalizeCode(input);
    const cached = this.cache.code(code, "JavBus");
    if (cached && !this.cleanup) return cached;
    if (this.active) throw new Error("正在查询影片资料，请稍候。");
    const abort = new AbortController();
    const active = AbortSignal.any([signal, abort.signal]);
    const timer = setTimeout(() => abort.abort(new Error("影片资料查询超时，请重试。")), 60000);
    const done = Promise.resolve().then(async () => {
      if (this.cleanup) {
        await this.cleanup();
        this.cleanup = undefined;
      }
      active.throwIfAborted();
      let failure: unknown;
      for (const prefix of ["", "/uncensored"]) {
        const work = {
          code,
          title: code,
          url: `${JAVBUS_ORIGIN}${prefix}/${encodeURIComponent(code)}`,
        };
        try {
          const html = await this.fetch!(work.url, active);
          active.throwIfAborted();
          const result = await this.processor.run("javbusDetails", { html, work });
          active.throwIfAborted();
          this.cache.remember(result);
          return result;
        } catch (error) {
          if (error instanceof StopUnconfirmedError) throw error;
          active.throwIfAborted();
          failure = error;
        }
      }
      throw failure ?? new Error("未找到匹配的影片资料。");
    });
    this.active = { abort, done };
    try {
      return await done;
    } catch (error) {
      if (error instanceof StopUnconfirmedError) this.cleanup = error.retry;
      throw error;
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }
  async shutdown() {
    this.stopped = true;
    this.active?.abort.abort();
    await this.active?.done.catch(() => {});
    await this.cleanup?.();
    this.cleanup = undefined;
  }
}
