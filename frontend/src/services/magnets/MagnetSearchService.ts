import { StopUnconfirmedError } from "../downloads/ports";
import { ResolutionError } from "../streamResolution/shared";
import { normalizeMagnet } from "./magnet";
import { magnetLimits, magnetQuery, magnetSources } from "./types";
import type { MagnetPage, MagnetResource, MagnetSourceId } from "./types";

interface SourceState {
  id: MagnetSourceId;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  page: number;
  hasMore: boolean;
  error: string;
}
export interface MagnetSnapshot {
  available: boolean;
  input: string;
  query: string;
  rows: MagnetResource[];
  sources: SourceState[];
  searching: boolean;
  stopping: boolean;
  cancelled: boolean;
  error: string;
  cleanupPending: boolean;
  opening: string;
  sent: string[];
}
export interface MagnetPort {
  merge(
    existing: readonly MagnetResource[],
    incoming: readonly MagnetResource[],
    signal: AbortSignal,
  ): Promise<MagnetResource[]>;
  search(
    source: MagnetSourceId,
    query: string,
    page: number,
    signal: AbortSignal,
  ): Promise<MagnetPage>;
  open(url: string): Promise<void>;
  close(): void;
}
interface Job {
  revision: number;
  source: MagnetSourceId;
  page: number;
  abort: AbortController;
  done: Promise<void>;
}
function searchError(error: unknown) {
  if (error instanceof ResolutionError) {
    if (error.code === "timeout") return "搜索服务响应超时，可稍后重试。";
    if (error.code === "rate_limited") return "搜索服务限制了请求频率，请稍后重试。";
    if (["interaction_required", "session_required"].includes(error.code))
      return "搜索服务需要验证，暂时无法自动查询。";
    if (error.code === "parse_failed") return "搜索页面无法解析，可能需要验证或适配已失效。";
    if (error.code === "limit_exceeded") return "搜索结果超过本次处理上限。";
  }
  return "搜索服务请求失败，请检查网络或代理后重试。";
}

/** 应用级服务：最多两项请求，旧请求确认结束后才释放名额。 */
export class MagnetSearchService {
  private snapshot: MagnetSnapshot;
  private listeners = new Set<() => void>();
  private revision = 0;
  private active = new Set<Job>();
  private pending: { source: MagnetSourceId; page: number }[] = [];
  private cleanup = new Set<() => Promise<void>>();
  private cleaning?: Promise<void>;
  private handoff?: Promise<void>;
  private stopped = false;
  private merging: Promise<void> = Promise.resolve();
  private views = new Map<string, number>();
  private viewQuery = "";
  constructor(private readonly port?: MagnetPort) {
    this.snapshot = {
      available: !!port,
      input: "",
      query: "",
      rows: [],
      sources: [],
      searching: false,
      stopping: false,
      cancelled: false,
      error: "",
      cleanupPending: false,
      opening: "",
      sent: [],
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<MagnetSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      searching:
        this.pending.length > 0 || [...this.active].some((job) => job.revision === this.revision),
      stopping: [...this.active].some((job) => job.revision !== this.revision),
      cleanupPending: this.cleanup.size > 0,
    };
    for (const listener of this.listeners) listener();
  }
  setInput = (input: string) => this.publish({ input: input.slice(0, 120) });
  matches = (query: string) => {
    try {
      return magnetQuery(query).toLowerCase() === this.snapshot.query.toLowerCase();
    } catch {
      return false;
    }
  };
  private stopRequests() {
    this.revision++;
    this.pending = [];
    for (const job of this.active) job.abort.abort();
  }
  search = (input = this.snapshot.input, tiedToView = false) => {
    if (this.stopped || !this.port) {
      this.publish({ error: "请在桌面应用中搜索磁力资源。" });
      return;
    }
    if (this.cleanup.size) {
      this.publish({ error: "上次搜索尚未完成清理，请先重试清理。" });
      return;
    }
    let query: string;
    try {
      query = magnetQuery(input);
    } catch (error) {
      this.publish({ error: (error as Error).message });
      return;
    }
    this.stopRequests();
    this.viewQuery = tiedToView ? query.toLowerCase() : "";
    this.pending = magnetSources.map(({ id }) => ({ source: id, page: 1 }));
    this.publish({
      input: query,
      query,
      rows: [],
      sent: [],
      error: "",
      cancelled: false,
      sources: magnetSources.map(({ id }) => ({
        id,
        page: 0,
        state: "queued",
        hasMore: false,
        error: "",
      })),
    });
    this.drain();
  };
  private updateSource(source: MagnetSourceId, patch: Partial<SourceState>) {
    this.publish({
      sources: this.snapshot.sources.map((row) => (row.id === source ? { ...row, ...patch } : row)),
    });
  }
  private drain() {
    while (!this.stopped && !this.cleanup.size && this.active.size < 2 && this.pending.length) {
      const { source, page } = this.pending.shift()!;
      const job: Job = {
        revision: this.revision,
        source,
        page,
        abort: new AbortController(),
        done: Promise.resolve(),
      };
      const query = this.snapshot.query;
      this.active.add(job);
      this.updateSource(source, { state: "running", error: "" });
      const timeout = setTimeout(
        () => job.abort.abort(new ResolutionError("timeout")),
        magnetLimits.sourceMs,
      );
      job.done = (async () => {
        try {
          const result = await this.port!.search(source, query, page, job.abort.signal);
          job.abort.signal.throwIfAborted();
          if (job.revision !== this.revision || this.stopped) return;
          const merge = this.merging.then(async () => {
            job.abort.signal.throwIfAborted();
            if (job.revision !== this.revision || this.stopped) return;
            const rows = await this.port!.merge(
              this.snapshot.rows,
              result.rows.slice(0, magnetLimits.pageRows),
              job.abort.signal,
            );
            job.abort.signal.throwIfAborted();
            if (job.revision === this.revision && !this.stopped) this.publish({ rows });
          });
          this.merging = merge.catch(() => {});
          await merge;
          if (job.revision !== this.revision || this.stopped) return;
          this.updateSource(source, {
            state: "succeeded",
            page,
            hasMore: result.hasMore && page < magnetLimits.pages,
          });
          // 先展示已返回结果，再按来源补足首批数量；沿用并发、取消和页数上限。
          if (
            job.revision === this.revision &&
            !this.stopped &&
            !job.abort.signal.aborted &&
            result.hasMore &&
            page < magnetLimits.pages &&
            this.snapshot.rows.length < magnetLimits.rows &&
            this.snapshot.rows.filter((row) => row.sources.includes(source)).length <
              magnetLimits.initialSourceRows
          )
            this.pending.push({ source, page: page + 1 });
        } catch (error) {
          if (error instanceof StopUnconfirmedError) {
            this.cleanup.add(error.retry);
            // 旧查询的清理失败同样保留所有权，不能由代次过滤掉。
            this.stopRequests();
            this.publish({
              error: "搜索尚未完成清理，请重试清理后再搜索。",
              sources: this.snapshot.sources.map((row) =>
                row.state === "running" || row.state === "queued"
                  ? { ...row, state: "cancelled" }
                  : row,
              ),
            });
          } else if (job.revision === this.revision && !this.stopped) {
            this.updateSource(source, {
              state: "failed",
              error: searchError(job.abort.signal.reason ?? error),
            });
          }
        } finally {
          clearTimeout(timeout);
          this.active.delete(job);
          this.drain();
          this.publish();
        }
      })();
    }
  }
  private enqueue(states: readonly SourceState[]) {
    if (
      this.stopped ||
      !this.port ||
      this.snapshot.searching ||
      this.active.size ||
      this.cleanup.size
    )
      return;
    this.pending = states.slice(0, 2).map((row) => ({ source: row.id, page: row.page + 1 }));
    if (!this.pending.length) return;
    this.publish({
      cancelled: false,
      error: "",
      sources: this.snapshot.sources.map((row) =>
        states.includes(row) ? { ...row, state: "queued", error: "" } : row,
      ),
    });
    this.drain();
  }
  retryFailed = () => this.enqueue(this.snapshot.sources.filter((row) => row.state === "failed"));
  loadMore = () => {
    if (this.snapshot.rows.length >= magnetLimits.rows) return;
    this.enqueue(this.snapshot.sources.filter((row) => row.state === "succeeded" && row.hasMore));
  };
  cancel = () => {
    this.stopRequests();
    this.publish({
      cancelled: true,
      sources: this.snapshot.sources.map((row) =>
        row.state === "queued" || row.state === "running" ? { ...row, state: "cancelled" } : row,
      ),
    });
  };
  holdView = (query: string) => {
    let key: string;
    try {
      key = magnetQuery(query).toLowerCase();
    } catch {
      return () => {};
    }
    this.views.set(key, (this.views.get(key) ?? 0) + 1);
    return () => {
      const left = (this.views.get(key) ?? 1) - 1;
      if (left > 0) this.views.set(key, left);
      else this.views.delete(key);
      setTimeout(() => {
        if (!this.views.has(key) && this.viewQuery === key && this.snapshot.searching)
          this.cancel();
      }, 0);
    };
  };
  retryCleanup = () => {
    if (this.cleaning) return this.cleaning;
    this.cleaning = (async () => {
      await Promise.all([...this.active].map((job) => job.done));
      for (const retry of [...this.cleanup]) {
        try {
          await retry();
          this.cleanup.delete(retry);
        } catch (error) {
          if (error instanceof StopUnconfirmedError) {
            this.cleanup.delete(retry);
            this.cleanup.add(error.retry);
          }
          throw new Error("搜索清理仍未完成，请重试或退出应用。");
        } finally {
          this.publish();
        }
      }
      this.publish({ error: "" });
    })().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  };
  copyResult = (id: string) => {
    const row = this.snapshot.rows.find((item) => item.id === id);
    const normalized = row && normalizeMagnet(row.magnet);
    if (!normalized) throw new Error("磁力资源已变化，请重新搜索。");
    return normalized.magnet;
  };
  openResult = async (id: string) => {
    if (!this.port || this.stopped) throw new Error("请在桌面应用中打开磁力链接。");
    if (this.handoff) throw new Error("正在打开下载器，请稍候。");
    const url = this.copyResult(id),
      revision = this.revision;
    this.publish({ opening: id });
    const handoff = Promise.resolve().then(() => this.port!.open(url));
    this.handoff = handoff;
    try {
      await handoff;
      if (this.revision === revision)
        this.publish({ sent: [...new Set([...this.snapshot.sent, id])] });
    } catch {
      throw new Error("无法打开外部下载器，请确认已安装并关联磁力协议，或复制磁力链接。");
    } finally {
      this.handoff = undefined;
      this.publish({ opening: "" });
    }
  };
  async shutdown() {
    this.stopped = true;
    this.cancel();
    await Promise.all([...this.active].map((job) => job.done));
    await this.handoff?.catch(() => {});
    await this.retryCleanup();
    this.port?.close();
    this.publish({ available: false });
  }
}
