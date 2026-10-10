import type { FacetQuery, PageRequest } from "../../contracts/library";
import { Observable } from "../metadata/shared";
import { StopUnconfirmedError } from "../downloads/ports";
import { catalogDimensions, catalogLabels, isCatalogDimension } from "./discoveryData";
import { avwikiSources, isAvwikiDimension } from "./avwikiCsv";
import type { AvwikiDimension } from "./avwikiCsv";
import type { PortraitService } from "./PortraitService";
import type {
  Additions,
  CatalogDimension,
  CatalogList,
  DiscoveryData,
  DiscoveryUpdate,
} from "./discoveryData";
import type { CatalogProcessor } from "./workerClient";
import { AvwikiWorksService } from "./AvwikiWorksService";

export interface DiscoveryCatalogPort {
  read(): Promise<string | null>;
  write(cache: string): Promise<void>;
  fetch(url: string, signal: AbortSignal): Promise<string>;
}
type Group = AvwikiDimension | "genres" | "entities";
const groupOf = (dimension: CatalogDimension): Group =>
  isAvwikiDimension(dimension) || dimension === "genres" ? dimension : "entities";
interface Snapshot {
  ready: boolean;
  available: boolean;
  revision: number;
  catalogs: Record<CatalogDimension, CatalogList>;
  updating: Group | null;
  completed: number;
  total: number;
  saving: boolean;
  errors: Partial<Record<Group, string>>;
  warning: string;
}
const DAY = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 60 * 60 * 1000;
// 目录续页每半小时最多处理八页；单次任务和并发均有界。
const INCREMENTAL_DELAY = 30 * 60 * 1000;
export class DiscoveryCatalogService extends Observable<Snapshot> {
  readonly works: AvwikiWorksService;
  private seeded?: Promise<void>;
  private initialized?: Promise<void>;
  private data?: DiscoveryData;
  private active?: Promise<void>;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private due: Record<Group, number> = {
    actresses: Infinity,
    maleActors: Infinity,
    directors: Infinity,
    studios: Infinity,
    series: Infinity,
    genres: Infinity,
    entities: Infinity,
  };
  private stopPending?: () => Promise<void>;
  private stopped = false;
  constructor(
    private processor: CatalogProcessor,
    private port?: DiscoveryCatalogPort,
    readonly portraits?: PortraitService,
  ) {
    super({
      ready: false,
      available: !!port,
      revision: 0,
      catalogs: Object.fromEntries(
        catalogDimensions.map((key): [CatalogDimension, CatalogList] => [
          key,
          { names: [], updatedAt: null },
        ]),
      ) as Snapshot["catalogs"],
      updating: null,
      completed: 0,
      total: 0,
      saving: false,
      errors: {},
      warning: "",
    });
    this.works = new AvwikiWorksService(processor, port?.fetch.bind(port), () => this.ready());
  }
  private accept(data: DiscoveryData) {
    this.data = data;
    this.publish({ ready: true, catalogs: data.catalogs, revision: this.snapshot.revision + 1 });
  }
  ready() {
    return (this.seeded ??= this.processor
      .run("discoveryLoad", { cache: null })
      .then((data) => {
        if (!this.stopped) this.accept(data);
      })
      .catch(() => {
        this.seeded = undefined;
        this.publish({ warning: "内置名单加载失败，请重试。" });
        throw new Error("内置名单加载失败，请重试。");
      }));
  }
  initialize() {
    return (this.initialized ??= this.load());
  }
  private async load() {
    try {
      await this.ready();
      if (!this.port || this.stopped) return;
      try {
        const cache = await this.port.read();
        if (cache) {
          const data = await this.processor.run("discoveryLoad", { cache });
          if (!this.stopped) this.accept(data);
        }
      } catch {
        this.publish({ warning: "缓存读取失败，正在使用内置名单。" });
      }
      this.due = {
        ...(Object.fromEntries(
          (Object.keys(avwikiSources) as AvwikiDimension[]).map((dimension) => [
            dimension,
            Math.max(
              this.snapshot.catalogs[dimension].updatedAt ?? 0,
              this.snapshot.catalogs[dimension].seedAt ?? 0,
            ) + (this.data!.directoryPages[dimension] === 1 ? DAY : INCREMENTAL_DELAY),
          ]),
        ) as Record<AvwikiDimension, number>),
        genres: (this.snapshot.catalogs.genres.updatedAt ?? 0) + DAY,
        entities: Infinity,
      };
      this.schedule();
    } catch {
      /* 加载失败通过状态显示，手动更新可以重试。 */
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.port || this.stopped || this.active) return;
    const next = (Object.keys(this.due) as Group[]).sort((a, b) => this.due[a] - this.due[b])[0]!;
    if (!Number.isFinite(this.due[next])) return;
    this.timer = setTimeout(
      () => {
        void this.refresh(next === "entities" ? "labels" : next);
      },
      Math.max(0, this.due[next] - Date.now()),
    );
  }
  refresh = (dimension: CatalogDimension) => {
    if (!this.port || this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    if (this.timer) clearTimeout(this.timer);
    const group = groupOf(dimension);
    this.active = this.update(group).finally(() => {
      this.active = undefined;
      this.schedule();
    });
    return this.active;
  };
  private async update(group: Group) {
    const abort = new AbortController();
    this.abort = abort;
    this.publish({
      updating: group,
      completed: 0,
      total: group === "genres" ? 2 : 1,
      saving: false,
      errors: { ...this.snapshot.errors, [group]: "" },
    });
    let success = false;
    try {
      await this.initialize();
      await this.ready();
      if (this.stopPending) {
        await this.stopPending();
        this.stopPending = undefined;
      }
      abort.signal.throwIfAborted();
      const fetch = async (url: string) => {
        const body = await this.port!.fetch(url, abort.signal);
        abort.signal.throwIfAborted();
        this.publish({ completed: this.snapshot.completed + 1 });
        return body;
      };
      let update: DiscoveryUpdate;
      if (isAvwikiDimension(group)) {
        let page = this.data!.directoryPages[group];
        let nextPage: number | null = page;
        const names: string[] = [];
        const portraits: Record<string, string> = Object.create(null);
        const entries: Record<string, string> = Object.create(null);
        this.publish({ total: 8 });
        // 同时只更新一个目录，每批最多八页；失败或取消不推进持久化游标。
        for (let count = 0; count < 8 && nextPage !== null; count++) {
          const url = `${avwikiSources[group]}${page === 1 ? "" : `?page=${page}`}`;
          const incoming = await this.processor.run("directory", {
            html: await fetch(url),
            dimension: group,
            page,
          });
          names.push(...incoming.names);
          Object.assign(portraits, incoming.portraits);
          Object.assign(entries, incoming.entries);
          nextPage = incoming.nextPage;
          if (nextPage !== null) page = nextPage;
        }
        this.publish({ total: this.snapshot.completed });
        update = { directory: { dimension: group, names, nextPage, portraits, entries } };
      } else if (group === "genres")
        update = {
          genrePages: {
            censored: await fetch("https://www.javbus.com/genre"),
            uncensored: await fetch("https://www.javbus.com/uncensored/genre"),
          },
        };
      else {
        const lane = this.data!.lane;
        let cursor = this.data!.cursors[lane];
        if (!cursor.pending.length)
          cursor = await this.processor.run("listing", {
            html: await fetch(`https://www.javbus.com${cursor.page}`),
            lane,
          });
        const batch = cursor.pending.slice(0, 8);
        this.publish({ total: this.snapshot.completed + batch.length });
        const names: Additions = {};
        for (const path of batch) {
          abort.signal.throwIfAborted();
          const incoming = await this.processor.run("entities", {
            html: await fetch(`https://www.javbus.com${path}`),
          });
          for (const dimension of catalogDimensions)
            if (incoming[dimension]) (names[dimension] ??= []).push(...incoming[dimension]!);
        }
        update = {
          entities: {
            names,
            lane,
            cursor: { ...cursor, pending: cursor.pending.slice(batch.length) },
          },
        };
      }
      const data = await this.processor.run("discoveryMerge", { cache: this.data!.cache, update });
      abort.signal.throwIfAborted();
      this.publish({ saving: true });
      let warning = "";
      try {
        await this.port!.write(data.cache);
      } catch {
        warning = "名单已更新，但缓存保存失败，下次启动仍使用原名单。";
      }
      if (!this.stopped) this.accept(data);
      this.publish({ warning });
      success = true;
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        this.stopPending = error.retry;
        this.publish({
          errors: { ...this.snapshot.errors, [group]: "更新进程尚未停止，请重试更新或退出。" },
        });
      } else if (!abort.signal.aborted)
        this.publish({
          errors: {
            ...this.snapshot.errors,
            [group]: error instanceof Error ? error.message : "名单更新失败，已保留原名单。",
          },
        });
    } finally {
      this.due[group] = abort.signal.aborted
        ? Infinity
        : Date.now() +
          (success
            ? group === "entities" ||
              (isAvwikiDimension(group) && this.data!.directoryPages[group] !== 1)
              ? INCREMENTAL_DELAY
              : DAY
            : RETRY_DELAY);
      this.abort = undefined;
      this.publish({ updating: null, saving: false });
    }
  }
  cancel = () => {
    if (!this.snapshot.saving) this.abort?.abort();
  };
  status(dimension: CatalogDimension) {
    const group = groupOf(dimension);
    return {
      active: this.snapshot.updating === group,
      error: this.snapshot.errors[group] ?? "",
      label: catalogLabels[dimension],
    };
  }
  async query(query: FacetQuery, page: PageRequest) {
    await this.ready();
    return this.processor.run("query", {
      names: isCatalogDimension(query.dimension)
        ? this.snapshot.catalogs[query.dimension].names
        : [],
      query,
      page,
    });
  }
  async shutdown() {
    await this.works.shutdown();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    await this.active;
    if (this.stopPending) {
      try {
        await this.stopPending();
        this.stopPending = undefined;
      } catch (error) {
        this.stopped = false;
        throw error;
      }
    }
    await this.initialized;
    await this.portraits?.shutdown();
    this.processor.close();
  }
}
