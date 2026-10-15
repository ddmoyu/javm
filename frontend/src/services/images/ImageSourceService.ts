export interface ImageSourcePort {
  load(url: string, referer: string | undefined, signal: AbortSignal): Promise<string>;
  copyCached?(
    url: string,
    referer: string | undefined,
    destination: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  invalidate(url: string, referer?: string): Promise<void>;
  shutdown(): Promise<void>;
}
export interface ResolvedImage {
  src: string;
  source: string;
}

export function imageCandidates(values: (string | undefined)[]) {
  return [...new Set(values.filter((value): value is string => !!value?.trim()))].slice(0, 8);
}

/** 本地挂载、内存图片和安全夹具直接展示；远程图片必须经应用网络服务。 */
export function isLocalImage(value: string) {
  if (/^(?:blob:|data:image\/(?:png|jpeg|webp|gif|avif)(?:;[^,]*)?,)/i.test(value)) return true;
  try {
    const base = typeof location === "undefined" ? "http://localhost" : location.origin;
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    if (url.origin === base) return true;
    return (
      typeof window !== "undefined" &&
      !!window.NL_PORT &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.port === String(window.NL_PORT) &&
      url.pathname.startsWith("/javm-")
    );
  } catch {
    return false;
  }
}

/** 生命周期独立于 React；网络并发、限频、去重由共享 HttpService 统一控制。 */
export class ImageSourceService {
  private stopped = false;
  private active = new Map<AbortController, Promise<unknown>>();
  constructor(private port?: ImageSourcePort) {}

  resolve(
    values: string[],
    referer: string | undefined,
    signal: AbortSignal,
  ): Promise<ResolvedImage> {
    return this.run(signal, (active) => this.load(values, referer, active));
  }
  copyCached(
    values: string[],
    referer: string | undefined,
    destination: string,
    signal: AbortSignal,
  ) {
    return this.run(signal, async (active) => {
      for (const source of imageCandidates(values)) {
        active.throwIfAborted();
        if (isLocalImage(source)) continue;
        if (await this.port?.copyCached?.(source, referer, destination, active)) return true;
      }
      return false;
    });
  }
  private run<T>(signal: AbortSignal, operation: (active: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped || this.active.size >= 64)
      return Promise.reject(new Error("图片读取繁忙，请稍后重试。"));
    const abort = new AbortController();
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => abort.abort(), 30_000);
    const task = operation(abort.signal).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      this.active.delete(abort);
    });
    this.active.set(abort, task);
    return task;
  }
  private async load(values: string[], referer: string | undefined, signal: AbortSignal) {
    for (const source of imageCandidates(values)) {
      signal.throwIfAborted();
      if (isLocalImage(source)) return { src: source, source };
      if (!this.port) continue;
      try {
        const src = await this.port.load(source, referer, signal);
        signal.throwIfAborted();
        return { src, source };
      } catch {
        signal.throwIfAborted();
      }
    }
    throw new Error("图片暂不可用");
  }
  async invalidate(source: string, referer?: string) {
    if (!isLocalImage(source)) await this.port?.invalidate(source, referer);
  }
  async shutdown() {
    this.stopped = true;
    for (const abort of this.active.keys()) abort.abort();
    await Promise.allSettled(this.active.values());
    await this.port?.shutdown();
  }
}
