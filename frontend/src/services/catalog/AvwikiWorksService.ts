import { Observable } from "../metadata/shared";
import type { MovieDetails } from "../metadata/MetaTubeService";
import { StopUnconfirmedError } from "../downloads/ports";
import type { CatalogProcessor } from "./workerClient";
import { avwikiEntityUrl } from "./avwikiWorks";
import type { AvwikiEntity, AvwikiWork, AvwikiWorksPage } from "./avwikiWorks";
import type { AvwikiDimension } from "./avwikiCsv";

interface Snapshot {
  available: boolean;
  selection: { dimension: AvwikiDimension; name: string } | null;
  entities: AvwikiEntity[];
  entity: AvwikiEntity | null;
  result: AvwikiWorksPage | null;
  page: number;
  loading: boolean;
  ready: boolean;
  error: string;
  detail: { work: AvwikiWork; value?: MovieDetails; loading: boolean; error: string } | null;
}
export class AvwikiWorksService extends Observable<Snapshot> {
  private generation = 0;
  private active?: Promise<void>;
  private abort?: AbortController;
  private pending?: () => void;
  private stopping = false;
  private cleanup?: () => Promise<void>;
  private cache = new Map<string, AvwikiWorksPage>();
  constructor(
    private processor: CatalogProcessor,
    private fetch: ((url: string, signal: AbortSignal) => Promise<string>) | undefined,
    private prepare: () => Promise<void>,
  ) {
    super({
      available: !!fetch,
      selection: null,
      entities: [],
      entity: null,
      result: null,
      page: 1,
      loading: false,
      ready: false,
      error: "",
      detail: null,
    });
  }
  // 至多一个请求和一个最新待办。快速切换先终止旧请求，再启动最后一次选择。
  private run(operation: (signal: AbortSignal) => Promise<void>, detail = false) {
    const generation = ++this.generation;
    this.abort?.abort();
    const launch = () => {
      if (this.stopping || generation !== this.generation) return;
      const abort = new AbortController();
      this.abort = abort;
      this.active = Promise.resolve()
        .then(async () => {
          if (this.cleanup) {
            await this.cleanup();
            this.cleanup = undefined;
          }
          abort.signal.throwIfAborted();
          if (!this.fetch) throw new Error("在线作品需要桌面正式版本；开发预览仅使用安全样例。");
          await operation(abort.signal);
        })
        .catch((error: unknown) => {
          if (error instanceof StopUnconfirmedError) this.cleanup = error.retry;
          if (generation !== this.generation || this.stopping || abort.signal.aborted) return;
          const message =
            error instanceof StopUnconfirmedError
              ? "作品请求尚未完成清理，请重试。"
              : error instanceof Error
                ? error.message
                : "作品读取失败，请重试。";
          if (detail && this.snapshot.detail)
            this.publish({ detail: { ...this.snapshot.detail, error: message, loading: false } });
          else this.publish({ error: message, ready: true });
        })
        .finally(() => {
          if (generation === this.generation) this.publish({ loading: false });
          this.active = undefined;
          this.abort = undefined;
          const next = this.pending;
          this.pending = undefined;
          next?.();
        });
    };
    if (this.active) this.pending = launch;
    else launch();
  }
  select = (dimension: AvwikiDimension, name: string) => {
    if (this.snapshot.selection?.dimension === dimension && this.snapshot.selection.name === name) {
      if (
        !this.snapshot.loading &&
        !this.snapshot.result &&
        (this.snapshot.entities.length <= 1 || this.snapshot.entity)
      )
        this.retry();
      return;
    }
    this.cache.clear();
    this.publish({
      selection: { dimension, name },
      entities: [],
      entity: null,
      result: null,
      page: 1,
      loading: true,
      ready: false,
      error: "",
      detail: null,
    });
    this.resolve();
  };
  private resolve() {
    const selection = this.snapshot.selection;
    if (!selection) return;
    this.publish({ loading: true, error: "" });
    this.run(async (signal) => {
      await this.prepare();
      signal.throwIfAborted();
      const entities = await this.processor.run("workEntities", selection);
      signal.throwIfAborted();
      this.publish({ entities, ready: true });
      if (!entities.length)
        throw new Error("该名称尚无明确的 AVWikiDB 来源身份，请更新名单或查看本地作品。");
      if (entities.length === 1) {
        this.publish({ entity: entities[0]! });
        await this.readPage(entities[0]!, 1, signal);
      }
    });
  }
  choose = (id: string) => {
    const entity = this.snapshot.entities.find((entry) => entry.id === id);
    if (!entity) return;
    this.publish({ entity, result: null, page: 1, detail: null });
    this.loadPage(1);
  };
  private async readPage(entity: AvwikiEntity, page: number, signal: AbortSignal, force = false) {
    const dimension = this.snapshot.selection!.dimension;
    const url = avwikiEntityUrl(dimension, entity.id, page);
    const cached = force ? undefined : this.cache.get(url);
    let result = cached;
    if (!result) {
      const html = await this.fetch!(url, signal);
      signal.throwIfAborted();
      result = await this.processor.run("works", { html, entity, page });
    }
    signal.throwIfAborted();
    this.cache.delete(url);
    this.cache.set(url, result);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    this.publish({ result, page, ready: true });
  }
  loadPage = (page: number, force = false) => {
    const entity = this.snapshot.entity;
    if (!entity || !Number.isInteger(page) || page < 1 || page > 1000) return;
    this.publish({ page, loading: true, error: "", detail: null });
    this.run((signal) => this.readPage(entity, page, signal, force));
  };
  retry = () => (this.snapshot.entity ? this.loadPage(this.snapshot.page, true) : this.resolve());
  open = (work: AvwikiWork) => {
    if (!this.snapshot.result?.items.some((item) => item.url === work.url)) return;
    this.publish({ detail: { work, loading: true, error: "" } });
    this.run(async (signal) => {
      const html = await this.fetch!(work.url, signal);
      signal.throwIfAborted();
      const value = await this.processor.run("workDetails", {
        html,
        work,
      });
      signal.throwIfAborted();
      this.publish({ detail: { work, value, loading: false, error: "" } });
    }, true);
  };
  closeDetail = () => {
    if (!this.snapshot.detail) return;
    this.cancel();
    this.publish({ detail: null });
  };
  cancel = () => {
    this.generation++;
    this.pending = undefined;
    this.abort?.abort();
    this.publish({
      loading: false,
      detail: this.snapshot.detail ? { ...this.snapshot.detail, loading: false } : null,
    });
  };
  async shutdown() {
    this.stopping = true;
    this.cancel();
    await this.active;
    if (this.cleanup) {
      try {
        await this.cleanup();
        this.cleanup = undefined;
      } catch (error) {
        this.stopping = false;
        throw error;
      }
    }
    this.cache.clear();
  }
}
