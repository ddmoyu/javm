import { Observable } from "../metadata/shared";
import type { CatalogProcessor } from "./workerClient";
import type { OnlineEntity } from "./onlineWorks";
import type { GenreLane } from "./catalogData";
import { javbusSearchUrl } from "./javbusWorks";
import { StopUnconfirmedError } from "../downloads/ports";
import { CatalogReadCancellation } from "./readCancellation";
import { logEvent } from "../logging/events";
interface Result {
  items: OnlineEntity[];
  next: Partial<Record<GenreLane, number | null>>;
  errors: Partial<Record<GenreLane, string>>;
}
export class OnlineActorSearchService extends Observable<
  Result & { available: boolean; query: string; page: number; loading: boolean; ready: boolean }
> {
  private active?: Promise<void>;
  private pending?: () => void;
  private abort?: AbortController;
  private generation = 0;
  private stopped = false;
  private cleanup?: () => Promise<void>;
  private cache = new Map<string, { at: number; result: Result }>();
  constructor(
    private processor: CatalogProcessor,
    private fetch?: (url: string, signal: AbortSignal) => Promise<string>,
  ) {
    super({
      available: !!fetch,
      query: "",
      page: 1,
      loading: false,
      ready: false,
      items: [],
      next: {},
      errors: {},
    });
  }
  search = (query: string, page = 1, force = false) => {
    query = query.trim();
    if (this.stopped) return;
    if (
      !force &&
      this.snapshot.query === query &&
      this.snapshot.page === page &&
      (this.snapshot.loading || this.snapshot.ready)
    )
      return;
    const generation = ++this.generation;
    this.abort?.abort(new CatalogReadCancellation("replaced"));
    this.pending = undefined;
    this.publish({ query, page, items: [], next: {}, errors: {}, loading: !!query, ready: !query });
    if (!query) return;
    if (force)
      for (const key of this.cache.keys()) {
        const [cachedQuery, cachedPage] = JSON.parse(key) as [string, number];
        if (cachedQuery === query && cachedPage >= page) this.cache.delete(key);
      }
    const launch = () => {
      if (this.stopped || generation !== this.generation) return;
      const abort = new AbortController();
      this.abort = abort;
      const timer = setTimeout(() => abort.abort(new Error("在线演员搜索超时，请重试。")), 60000);
      this.active = (async () => {
        if (this.cleanup) {
          await this.cleanup();
          this.cleanup = undefined;
        }
        abort.signal.throwIfAborted();
        if (!this.fetch) throw new Error("在线演员搜索需要 Windows 桌面版。");
        if (!Number.isInteger(page) || page < 1 || page > 1000)
          throw new Error("演员搜索页码无效。");
        const key = JSON.stringify([query, page]);
        const saved = this.cache.get(key);
        if (!force && saved && Date.now() - saved.at < 300000) {
          this.publish({ ...saved.result, ready: true });
          return;
        }
        const result: Result = { items: [], next: {}, errors: {} };
        for (const lane of ["censored", "uncensored"] as const) {
          abort.signal.throwIfAborted();
          const previous = this.cache.get(JSON.stringify([query, page - 1]));
          if (page > 1 && previous?.result.next[lane] === null) {
            result.next[lane] = null;
            continue;
          }
          try {
            const base = javbusSearchUrl("actresses", query, lane);
            const url = page === 1 ? base : `${base}/${page}`;
            const html = await this.fetch(url, abort.signal);
            abort.signal.throwIfAborted();
            const parsed = await this.processor.run("javbusActorSearch", { html, url, page });
            abort.signal.throwIfAborted();
            for (const item of parsed.items)
              if (!result.items.some((existing) => existing.id === item.id))
                result.items.push(item);
            result.next[lane] = parsed.nextPage;
          } catch (error) {
            if (error instanceof StopUnconfirmedError) throw error;
            abort.signal.throwIfAborted();
            result.errors[lane] = error instanceof Error ? error.message : "搜索失败，请重试。";
          }
          if (generation === this.generation)
            this.publish({
              ...result,
              items: [...result.items],
              errors: { ...result.errors },
              next: { ...result.next },
            });
        }
        if (generation !== this.generation) return;
        if (!Object.keys(result.errors).length) {
          this.cache.delete(key);
          this.cache.set(key, { at: Date.now(), result });
          if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
        }
        this.publish({ ...result, ready: true });
      })()
        .catch((error: unknown) => {
          if (error instanceof StopUnconfirmedError) {
            this.cleanup = error.retry;
            // 取消不等于清理成功；即使请求已被替换，清理失败仍需要反馈。
            if (generation !== this.generation)
              logEvent("error", "catalog", "actor_cleanup_failed", error.message, {
                action: "actor_search",
                page,
              });
          }
          if (generation === this.generation) {
            const reason = abort.signal.aborted ? abort.signal.reason : error;
            this.publish({
              ready: true,
              errors: { censored: reason instanceof Error ? reason.message : "搜索失败，请重试。" },
            });
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (generation === this.generation) {
            this.publish({ loading: false });
            const errors = Object.values(this.snapshot.errors);
            if (errors.length)
              logEvent("error", "catalog", "actor_search_failed", errors.join("；"), {
                action: "actor_search",
                page,
              });
          }
          this.active = undefined;
          this.abort = undefined;
          const next = this.pending;
          this.pending = undefined;
          next?.();
        });
    };
    if (this.active) this.pending = launch;
    else launch();
  };
  retry = () => this.search(this.snapshot.query, this.snapshot.page, true);
  cancel = () => {
    ++this.generation;
    this.pending = undefined;
    this.abort?.abort(new CatalogReadCancellation("view_closed"));
    this.publish({ loading: false, ready: false });
  };
  async shutdown() {
    this.stopped = true;
    this.cancel();
    await this.active;
    await this.cleanup?.();
  }
}
