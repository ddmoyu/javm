import type { MetadataDiagnostics } from "./diagnostics";

export type MetadataConnectivityStatus = "reachable" | "unreachable" | "unknown";
export const metadataNetworkNotice = "当前网络无法连接资料服务，请检查网络后重试。";
export const metadataQueueNotice =
  "当前网络无法连接资料服务，队列已暂停。网络恢复后点击“继续队列”重试。";

/** 只有来源的连接故障才需要检测；本地服务故障、纯空结果和纯解析失败不参与。 */
export function needsMetadataConnectivity(diagnostic: MetadataDiagnostics) {
  return (
    diagnostic.sources.some(
      (source) =>
        source.provider !== "MetaTube" &&
        ["dns", "network", "timeout", "tls"].includes(source.category),
    ) &&
    !diagnostic.sources.some(
      (source) =>
        source.category === "service" ||
        (source.provider === "MetaTube" &&
          !["found", "empty", "skipped"].includes(source.category)),
    )
  );
}

/** 一个实例对应一次 MetaTube 启动的有效代理配置，不读取查询期间的新配置。 */
export class MetadataConnectivity {
  private cached?: { status: MetadataConnectivityStatus; expires: number };
  private active?: {
    abort: AbortController;
    done: Promise<MetadataConnectivityStatus>;
    users: number;
  };
  private stopped = false;
  constructor(
    private probe: (signal: AbortSignal) => Promise<MetadataConnectivityStatus>,
    private now = Date.now,
  ) {}

  async check(signal: AbortSignal): Promise<MetadataConnectivityStatus> {
    signal.throwIfAborted();
    if (this.stopped) throw new DOMException("检测已停止", "AbortError");
    if (this.cached && this.cached.expires > this.now()) return this.cached.status;
    if (this.active?.abort.signal.aborted) {
      // 等待上一轮取消清理，避免反复点击产生并行检测。
      await this.wait(
        this.active.done.catch(() => {}),
        signal,
      );
      return this.check(signal);
    }
    if (!this.active) {
      const abort = new AbortController();
      const job = {
        abort,
        users: 0,
        done: Promise.resolve().then(() => this.probe(abort.signal)),
      };
      this.active = job;
      job.done = job.done
        .then((status) => {
          if (!abort.signal.aborted && status !== "unknown")
            this.cached = { status, expires: this.now() + 30_000 };
          return status;
        })
        .finally(() => {
          if (this.active === job) this.active = undefined;
        });
      // 最后一个调用者取消后，仍接收后台清理的拒绝结果。
      void job.done.catch(() => {});
    }
    const job = this.active;
    job.users++;
    try {
      return await this.wait(job.done, signal);
    } finally {
      if (--job.users === 0 && this.active === job) job.abort.abort();
    }
  }

  private wait<T>(done: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void done.then(
        (value) => {
          signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }

  async dispose() {
    this.stopped = true;
    this.cached = undefined;
    this.active?.abort.abort();
    await this.active?.done.catch(() => {});
  }
}
