import type { CatalogProcessor } from "./workerClient";
import type { ActorDirectoryDimension } from "./discoveryData";

export interface PortraitPort {
  load(url: string, signal: AbortSignal, key: string): Promise<string>;
  cached?(
    dimension: ActorDirectoryDimension,
    names: string[],
    signal: AbortSignal,
  ): Promise<Record<string, string>>;
  index(signal: AbortSignal): Promise<string>;
  invalidateIndex?(): Promise<void>;
  shutdown(): Promise<void>;
}
export class PortraitService {
  private stopped = false;
  private controllers = new Set<AbortController>();
  private tasks = new Set<Promise<unknown>>();
  private index?: Promise<void>;
  private retryIndexAt = 0;
  private abortIndex = new AbortController();
  private slots = Array.from({ length: 4 }, () => Promise.resolve());
  private sequence = 0;
  constructor(
    private processor: CatalogProcessor,
    private port: PortraitPort,
  ) {}
  private loadImage(url: string, signal: AbortSignal, key: string) {
    const slot = this.sequence++ % this.slots.length;
    const task = this.slots[slot]!.then(() => {
      signal.throwIfAborted();
      return this.port.load(url, signal, key);
    });
    this.slots[slot] = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private prepareFallback() {
    if (Date.now() < this.retryIndexAt) return Promise.reject(new Error("备用头像暂不可用。"));
    return (this.index ??= this.port
      .index(this.abortIndex.signal)
      .then((json) => this.processor.run("portraitIndex", { json }))
      .then(() => {})
      .catch(async () => {
        await this.port.invalidateIndex?.().catch(() => {});
        this.index = undefined;
        this.retryIndexAt = Date.now() + 3_600_000;
        throw new Error("备用头像暂不可用。");
      }));
  }
  load(
    dimension: ActorDirectoryDimension,
    names: string[],
    signal: AbortSignal,
    progress?: (completed: number, total: number, images: Record<string, string>) => void,
  ): Promise<Record<string, string>> {
    if (this.stopped || names.length > 50 || this.controllers.size >= 2) return Promise.resolve({});
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    this.controllers.add(abort);
    const task = this.run(dimension, names, abort.signal, progress).finally(() => {
      signal.removeEventListener("abort", cancel);
      this.controllers.delete(abort);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return task;
  }
  private async run(
    dimension: ActorDirectoryDimension,
    names: string[],
    signal: AbortSignal,
    progress?: (completed: number, total: number, images: Record<string, string>) => void,
  ) {
    const result: Record<string, string> = Object.create(null);
    const primary = await this.processor.run("portraits", { dimension, names });
    signal.throwIfAborted();
    const cached = await this.port.cached?.(
      dimension,
      names.filter((name) => Object.hasOwn(primary, name)),
      signal,
    );
    if (cached) Object.assign(result, cached);
    const missing: string[] = [];
    let completed = Object.keys(result).length;
    let lastProgress = 0;
    const report = () => {
      if (Date.now() - lastProgress >= 100 || completed === names.length) {
        lastProgress = Date.now();
        progress?.(completed, names.length, { ...result });
      }
    };
    const pool = async (batch: string[], urls: Record<string, string[]>, first: boolean) => {
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, batch.length) }, async () => {
          while (cursor < batch.length) {
            signal.throwIfAborted();
            const name = batch[cursor++]!;
            for (const url of urls[name] ?? []) {
              try {
                result[name] = await this.loadImage(url, signal, `${dimension}:${name}`);
                break;
              } catch {
                signal.throwIfAborted();
              }
            }
            if (first && !result[name]) missing.push(name);
            if (!first || result[name]) {
              completed++;
              report();
            }
          }
        }),
      );
    };
    report();
    await pool(
      names.filter((name) => !Object.hasOwn(result, name)),
      primary,
      true,
    );
    if (missing.length) {
      try {
        await this.prepareFallback();
        signal.throwIfAborted();
        const fallback = await this.processor.run("portraits", {
          dimension,
          names: missing,
          fallback: true,
        });
        await pool(missing, fallback, false);
      } catch {
        signal.throwIfAborted();
      }
    }
    completed = names.length;
    report();
    return result;
  }
  async shutdown() {
    this.stopped = true;
    this.abortIndex.abort();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.tasks, ...(this.index ? [this.index] : [])]);
    await this.port.shutdown();
  }
}
