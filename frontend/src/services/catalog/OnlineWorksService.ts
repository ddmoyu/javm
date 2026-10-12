import { Observable } from "../metadata/shared";
import type { MovieDetails } from "../metadata/MetaTubeService";
import { StopUnconfirmedError } from "../downloads/ports";
import type { CatalogProcessor } from "./workerClient";
import type { OnlineEntity, OnlineWork, OnlineWorksPage } from "./onlineWorks";
import { CatalogReadCancellation } from "./readCancellation";
import { javbusEntityUrl, javbusSearchUrl, entityOf } from "./javbusWorks";
import type { WorksDimension } from "./javbusWorks";
import { javbusEntryFromEntity } from "./javbusCatalog";
import type { JavbusCatalogEntry } from "./javbusCatalog";

interface Snapshot {
  available: boolean;
  selection: { dimension: WorksDimension; name: string } | null;
  entities: OnlineEntity[];
  entity: OnlineEntity | null;
  result: OnlineWorksPage | null;
  page: number;
  loading: boolean;
  ready: boolean;
  error: string;
  detail: { work: OnlineWork; value?: MovieDetails; loading: boolean; error: string } | null;
}
export class OnlineWorksService extends Observable<Snapshot> {
  private generation = 0;
  private active?: Promise<void>;
  private abort?: AbortController;
  private pending?: () => void;
  private stopping = false;
  private cleanup?: () => Promise<void>;
  private cache = new Map<string, OnlineWorksPage>();
  private identities = new Map<string, { at: number; entities: OnlineEntity[] }>();
  constructor(
    private processor: CatalogProcessor,
    private fetch: ((url: string, signal: AbortSignal) => Promise<string>) | undefined,
    private prepare: () => Promise<void>,
    private observe?: (entries: JavbusCatalogEntry[], signal: AbortSignal) => Promise<void>,
    private rememberDetails?: (value: MovieDetails) => void,
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
    this.abort?.abort(new CatalogReadCancellation("replaced"));
    const launch = () => {
      if (this.stopping || generation !== this.generation) return;
      const abort = new AbortController();
      this.abort = abort;
      const timer = setTimeout(() => abort.abort(new Error("JavBus 读取超时，请重试。")), 60_000);
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
          if (generation !== this.generation || this.stopping) return;
          const cause = abort.signal.aborted ? abort.signal.reason : error;
          const message =
            error instanceof StopUnconfirmedError
              ? "作品请求尚未完成清理，请重试。"
              : cause instanceof Error
                ? cause.message
                : "作品读取失败，请重试。";
          if (detail && this.snapshot.detail)
            this.publish({ detail: { ...this.snapshot.detail, error: message, loading: false } });
          else this.publish({ error: message, ready: true });
        })
        .finally(() => {
          clearTimeout(timer);
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
  select = (dimension: WorksDimension, name: string) => {
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
      const entities = await this.resolveJavbus(selection, signal);
      signal.throwIfAborted();
      this.publish({ entities, ready: true });
      if (!entities.length)
        throw new Error("未找到与该名称或明确别名匹配的 JavBus 条目，可查看本地已收录作品。");
      if (entities.length === 1) {
        this.publish({ entity: entities[0]! });
        await this.readPage(entities[0]!, 1, signal);
      }
    });
  }
  private async resolveJavbus(
    selection: { dimension: WorksDimension; name: string },
    signal: AbortSignal,
  ) {
    const key = JSON.stringify(selection);
    const saved = this.identities.get(key);
    if (saved && Date.now() - saved.at < 10 * 60_000) return saved.entities;
    const plan = await this.processor.run("javbusPlan", selection);
    signal.throwIfAborted();
    const found = new Map(plan.entities.map((entity) => [entity.url, entity]));
    const actor = selection.dimension === "actresses" || selection.dimension === "maleActors";
    const visited = new Set<string>();
    // 名称最多三个、每个分区一页；其他维度最多读取四个候选详情确认对应链接。
    if (!found.size && selection.dimension !== "genres") {
      for (const name of plan.queries) {
        for (const lane of ["censored", "uncensored"] as const) {
          signal.throwIfAborted();
          const url = javbusSearchUrl(selection.dimension, name, lane);
          const html = await this.fetch!(url, signal);
          signal.throwIfAborted();
          if (actor) {
            const matches = await this.processor.run("javbusActors", { html, names: plan.names });
            signal.throwIfAborted();
            for (const entity of matches) found.set(entity.url, entity);
          } else {
            const result = await this.processor.run("javbusWorks", { html, url, page: 1 });
            for (const work of result.items.slice(0, 2)) {
              signal.throwIfAborted();
              if (visited.has(work.url) || visited.size >= 4) continue;
              visited.add(work.url);
              const detail = await this.fetch!(work.url, signal);
              signal.throwIfAborted();
              // 同时验证详情番号；不从导航栏、广告或其他作品中推测来源身份。
              await this.processor.run("javbusDetails", { html: detail, work });
              const matches = await this.processor.run("javbusFacets", {
                html: detail,
                names: plan.names,
                dimension: selection.dimension,
              });
              signal.throwIfAborted();
              for (const entity of matches) found.set(entity.url, entity);
            }
          }
        }
        if (found.size || (!actor && visited.size >= 4)) break;
      }
    }
    signal.throwIfAborted();
    const entities = [...found.values()];
    if (entities.length) {
      this.identities.delete(key);
      this.identities.set(key, { at: Date.now(), entities });
      if (this.identities.size > 64) this.identities.delete(this.identities.keys().next().value!);
    }
    return entities;
  }
  choose = (id: string) => {
    const entity = this.snapshot.entities.find((entry) => entry.id === id);
    if (!entity) return;
    this.publish({ entity, result: null, page: 1, detail: null });
    this.loadPage(1);
  };
  selectEntity = (dimension: WorksDimension, entity: OnlineEntity) => {
    const valid = entityOf(entity.url, entity.name, dimension);
    if (!valid || valid.id !== entity.id) throw new Error("演员来源身份无效，请重新搜索。");
    this.cache.clear();
    this.publish({
      selection: { dimension, name: entity.name },
      entities: [entity],
      entity,
      result: null,
      page: 1,
      detail: null,
      ready: true,
      error: "",
    });
    this.loadPage(1);
  };
  private async readPage(
    entity: OnlineEntity,
    page: number,
    signal: AbortSignal,
    force = false,
    append = false,
  ) {
    const dimension = this.snapshot.selection!.dimension;
    const url = javbusEntityUrl(entity, page);
    const cached = force ? undefined : this.cache.get(url);
    let result = cached;
    if (!result) {
      const html = await this.fetch!(url, signal);
      signal.throwIfAborted();
      result = await this.processor.run("javbusWorks", { html, url, page });
    }
    signal.throwIfAborted();
    if (!cached && this.observe) {
      const entry = javbusEntryFromEntity(entity, dimension, Date.now(), result.total);
      entry.aliases =
        entity.name === this.snapshot.selection!.name ? [] : [this.snapshot.selection!.name];
      await this.observe([entry], signal);
      signal.throwIfAborted();
    }
    this.cache.delete(url);
    this.cache.set(url, result);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    const previous = this.snapshot.result;
    if (append && previous && previous.page === page - 1) {
      // 滚动加载把新页追加到已读列表；跨页重复的作品只保留首次出现。
      const seen = new Set(previous.items.map((work) => work.url));
      result = {
        ...result,
        items: [...previous.items, ...result.items.filter((work) => !seen.has(work.url))],
        total: result.total ?? previous.total,
        ...(result.profile || previous.profile
          ? { profile: result.profile ?? previous.profile }
          : {}),
      };
    }
    this.publish({ result, page, ready: true });
  }
  loadPage = (page: number, force = false) => {
    const entity = this.snapshot.entity;
    if (!entity || !Number.isInteger(page) || page < 1 || page > 1000) return;
    this.publish({ page, loading: true, error: "", detail: null });
    this.run((signal) => this.readPage(entity, page, signal, force));
  };
  loadMore = () => {
    const { entity, result, loading, error } = this.snapshot;
    if (!entity || !result || loading || error || result.nextPage === null) return;
    const page = result.nextPage;
    this.publish({ loading: true, error: "" });
    this.run((signal) => this.readPage(entity, page, signal, false, true));
  };
  retryMore = () => {
    this.publish({ error: "" });
    this.loadMore();
  };
  retry = () =>
    this.snapshot.entity
      ? this.loadPage(this.snapshot.error ? this.snapshot.page : 1, true)
      : this.resolve();
  private async readDetail(work: OnlineWork, signal: AbortSignal) {
    if (this.stopping || !this.fetch) throw new Error("在线作品服务暂不可用。");
    await this.prepare();
    signal.throwIfAborted();
    const html = await this.fetch(work.url, signal);
    signal.throwIfAborted();
    const value = await this.processor.run("javbusDetails", { html, work });
    signal.throwIfAborted();
    this.rememberDetails?.(value);
    return { html, value };
  }
  async readDetails(work: OnlineWork, signal: AbortSignal) {
    return (await this.readDetail(work, signal)).value;
  }
  open = (work: OnlineWork) => {
    if (!this.snapshot.result?.items.some((item) => item.url === work.url)) return;
    this.publish({ detail: { work, loading: true, error: "" } });
    this.run(async (signal) => {
      const { html, value } = await this.readDetail(work, signal);
      if (this.observe) {
        const entries = await this.processor.run("javbusRelations", { html });
        signal.throwIfAborted();
        await this.observe(entries, signal);
        signal.throwIfAborted();
      }
      this.publish({ detail: { work, value, loading: false, error: "" } });
    }, true);
  };
  closeDetail = () => {
    if (!this.snapshot.detail) return;
    this.cancel();
    this.publish({ detail: null });
  };
  private cancelWithReason(reason: "view_closed" | "shutdown") {
    this.generation++;
    this.pending = undefined;
    this.abort?.abort(new CatalogReadCancellation(reason));
    this.publish({
      loading: false,
      detail: this.snapshot.detail ? { ...this.snapshot.detail, loading: false } : null,
    });
  }
  cancel = () => this.cancelWithReason("view_closed");
  async shutdown() {
    this.stopping = true;
    this.cancelWithReason("shutdown");
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
    this.identities.clear();
  }
}
