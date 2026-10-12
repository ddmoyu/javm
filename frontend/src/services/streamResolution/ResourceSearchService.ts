import type { NewDownload } from "../../contracts/downloads";
import type {
  ResolutionHandle,
  ResolutionState,
  ResolvedStream,
} from "../../contracts/streamResolution";
import type { ResolutionService } from "./ResolutionService";
import { normalizeCode, resourceSources, sourceRequest } from "./sources";
import type { ResourceSource } from "./sources";
import { rankResourceSources, readSourcePerformance } from "./sourcePerformance";
import type { SourcePerformanceMap } from "./sourcePerformance";
import { resourceLinkKey } from "./resourceLinks";
import { bounds } from "./shared";
import { archivedStream, resourceRecord } from "./archive";
import type {
  ResourceArchive,
  ResourcePreferences,
  ResourceRecord,
  SavedResource,
} from "./archive";

export interface ResourceRow {
  sourceId: string;
  sourceName: string;
  taskId: string;
  state: ResolutionState;
  stream?: ResolvedStream;
  error?: string;
  handingOff: boolean;
  added: boolean;
  saved?: boolean;
}
export interface ResourceSearchSnapshot {
  available: boolean;
  query: string;
  code: string;
  workId?: string;
  selected: string[];
  filter: "all" | "found" | "failed";
  busy: boolean;
  searching: boolean;
  completed: number;
  total: number;
  cancelled: boolean;
  sourcePerformance: SourcePerformanceMap;
  rows: ResourceRow[];
  error: string;
  cleanupPending: number;
  restoring: boolean;
  archiveRevision: number;
  storageError: string;
}
export interface ResourceDownloadPort {
  add(input: NewDownload): Promise<number>;
  directory(): string;
}
/** 查询与结果属于应用，不随 React 页面切换或 StrictMode 重新启动。 */
export class ResourceSearchService {
  private handles = new Map<string, ResolutionHandle>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private stopped = false;
  private workId?: string;
  private handoffs = new Set<Promise<void>>();
  private unsubscribe: () => void;
  private snapshot: ResourceSearchSnapshot;
  private restoring: Promise<void>;
  private writes = new Set<Promise<void>>();
  private savedActions = new Set<string>();
  private preferenceTimer?: ReturnType<typeof setTimeout>;
  private preferenceWrite?: Promise<void>;
  private preferencesDirty = false;
  private pendingSources: ResourceSource[] = [];
  private views = new Map<string, number>();
  constructor(
    private readonly resolution: ResolutionService,
    private readonly downloads: ResourceDownloadPort,
    readonly sources: readonly ResourceSource[] = resourceSources,
    private readonly archive?: ResourceArchive,
  ) {
    this.snapshot = {
      available: resolution.getSnapshot().webviewAvailable,
      query: "",
      code: "",
      selected: sources.slice(0, 32).map((source) => source.id),
      filter: "all",
      busy: false,
      searching: false,
      completed: 0,
      total: 0,
      cancelled: false,
      sourcePerformance: {},
      rows: [],
      error: "",
      cleanupPending: 0,
      restoring: !!archive,
      archiveRevision: 0,
      storageError: "",
    };
    this.unsubscribe = resolution.subscribe(() => {
      const state = resolution.getSnapshot();
      this.snapshot = {
        ...this.snapshot,
        available: state.webviewAvailable && !this.stopped,
        cleanupPending: state.cleanupPending,
        rows: this.snapshot.rows.map((row) => {
          const task = state.tasks.find((item) => item.id === row.taskId);
          return task && !row.stream ? { ...row, state: task.state } : row;
        }),
      };
      this.publish();
    });
    this.restoring = this.restore();
  }
  initialize = () => this.restoring;
  private async restore() {
    if (!this.archive) return;
    try {
      const raw = await this.archive.readPreferences();
      if (this.stopped || !raw) return;
      const value = raw as Partial<ResourcePreferences>;
      if (typeof value.query !== "string") throw new Error();
      this.snapshot = {
        ...this.snapshot,
        sourcePerformance: readSourcePerformance(value.sourcePerformance, this.sources),
      };
      this.workId = typeof value.workId === "string" ? value.workId : undefined;
      const code = value.code ? normalizeCode(value.code) : "";
      const rows = code ? await this.readSaved(code, this.workId) : [];
      if (this.stopped) return;
      this.snapshot = {
        ...this.snapshot,
        query: value.query.slice(0, 80),
        code,
        workId: this.workId,
        // 旧版手动选择不再限制自动查找；已保存的链接和查询仍然保留。
        selected: this.sources.slice(0, 32).map((source) => source.id),
        filter: value.filter === "found" || value.filter === "failed" ? value.filter : "all",
        rows: rows.map((row) => ({
          ...row,
          taskId: `saved:${row.id}`,
          state: "succeeded",
          handingOff: false,
          added: false,
          saved: true,
        })),
      };
    } catch {
      this.snapshot = {
        ...this.snapshot,
        storageError: "资源历史读取失败，请检查数据目录后重新打开应用。",
      };
    } finally {
      this.snapshot = { ...this.snapshot, restoring: false };
      this.publish();
    }
  }
  private savePreferences() {
    if (!this.archive || this.snapshot.restoring || this.stopped) return;
    this.preferencesDirty = true;
    clearTimeout(this.preferenceTimer);
    this.preferenceTimer = setTimeout(() => {
      void this.flushPreferences();
    }, 250);
  }
  private flushPreferences(): Promise<void> {
    if (this.preferenceWrite) return this.preferenceWrite;
    const job = (async () => {
      while (this.archive && this.preferencesDirty) {
        this.preferencesDirty = false;
        const { query, code, selected, filter } = this.snapshot;
        try {
          await this.archive.writePreferences({
            query,
            code,
            selected,
            filter,
            workId: this.workId,
            sourcePerformance: this.snapshot.sourcePerformance,
          });
        } catch {
          this.snapshot = {
            ...this.snapshot,
            storageError: "资源查询设置保存失败，请检查数据目录后重试。",
          };
          this.publish();
        }
      }
    })();
    this.preferenceWrite = job;
    void job.finally(() => {
      if (this.preferenceWrite === job) this.preferenceWrite = undefined;
    });
    return job;
  }
  readSaved = async (code: string, workId?: string): Promise<SavedResource[]> => {
    if (!this.archive || !code) return [];
    const rows = await this.archive.read(normalizeCode(code), workId);
    const seen = new Set<string>();
    return rows
      .slice(0, 20)
      .filter((row) => {
        if (seen.has(row.sourceId)) return false;
        seen.add(row.sourceId);
        return true;
      })
      .map((row) => ({ ...row, stream: archivedStream(row.stream) }));
  };
  private remember(record: ResourceRecord) {
    if (!this.archive) return Promise.resolve();
    if (this.writes.size >= 16)
      return Promise.reject(new Error("资源保存队列繁忙，请稍后重新查找。"));
    const job = Promise.resolve()
      .then(() => this.archive!.save(resourceRecord(record)))
      .then(() => {
        this.snapshot = { ...this.snapshot, archiveRevision: this.snapshot.archiveRevision + 1 };
        this.publish();
      });
    this.writes.add(job);
    void job.then(
      () => this.writes.delete(job),
      () => this.writes.delete(job),
    );
    return job;
  }
  removeSaved = async (id: string) => {
    if (!this.archive || this.stopped) return;
    await this.archive.remove(id);
    this.snapshot = { ...this.snapshot, archiveRevision: this.snapshot.archiveRevision + 1 };
    this.publish();
  };
  dismissResult = (url: string) => {
    const key = resourceLinkKey(url);
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.filter((row) => {
        if (!row.stream) return true;
        return resourceLinkKey(row.stream.manifestUrl) !== key;
      }),
    };
    this.publish();
  };
  useSaved = (
    record: SavedResource,
    action: "copy" | "download",
    workId?: string,
  ): Promise<string> => {
    if (this.stopped || this.savedActions.has(record.id) || this.savedActions.size >= 4)
      return Promise.reject(new Error("请等待当前资源检查完成。"));
    this.savedActions.add(record.id);
    let url = "";
    const job = (async () => {
      const key = `saved:${record.id}`;
      try {
        const input = archivedStream(record.stream);
        const check = this.resolution.submit({
          url: input.manifestUrl,
          provider: "direct-hls",
          publicHeaders: input.context.publicHeaders,
          preferProxy: input.context.preferProxy,
        });
        this.handles.set(key, check);
        this.publish();
        const result = await check.result;
        if (!result.ok) throw new Error(result.message);
        if (this.stopped) throw new Error("资源查找服务正在退出。");
        const stream = {
          ...result.streams[0]!,
          pageUrl: input.pageUrl,
          discoveredBy: input.discoveredBy,
        };
        url = stream.manifestUrl;
        // A stored address is only a candidate until it has been checked again.
        await this.remember({ ...record, workId: workId ?? record.workId, stream }).catch(() => {
          this.snapshot = { ...this.snapshot, storageError: "链接已检查，但资源历史更新失败。" };
          this.publish();
        });
        if (this.stopped) throw new Error("资源查找服务正在退出。");
        if (action === "download")
          await this.downloads.add({
            urls: [url],
            kind: "hls",
            name: record.code,
            directory: this.downloads.directory(),
            headers: { ...stream.context.publicHeaders },
            workId: workId ?? record.workId,
          });
      } finally {
        this.handles.delete(key);
        this.savedActions.delete(record.id);
        this.publish();
      }
    })();
    this.handoffs.add(job);
    void job.then(
      () => this.handoffs.delete(job),
      () => this.handoffs.delete(job),
    );
    return job.then(() => url);
  };
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish() {
    const searching =
      this.pendingSources.length > 0 || this.sources.some((source) => this.handles.has(source.id));
    this.snapshot = { ...this.snapshot, busy: this.handles.size > 0 || searching, searching };
    for (const listener of this.listeners) listener();
  }
  setQuery = (query: string) => {
    this.snapshot = { ...this.snapshot, query: query.slice(0, 80) };
    this.publish();
    this.savePreferences();
  };
  setSources = (selected: string[]) => {
    this.snapshot = {
      ...this.snapshot,
      selected: [...new Set(selected)]
        .filter((id) => this.sources.some((s) => s.id === id))
        .slice(0, 32),
    };
    this.publish();
    this.savePreferences();
  };
  setFilter = (filter: ResourceSearchSnapshot["filter"]) => {
    this.snapshot = { ...this.snapshot, filter };
    this.publish();
    this.savePreferences();
  };
  search = (query = this.snapshot.query, workId?: string) => {
    this.snapshot = { ...this.snapshot, query: query.slice(0, 80) };
    try {
      if (this.stopped || !this.snapshot.available)
        throw new Error("请在 Windows 桌面应用中查找资源。");
      if (this.snapshot.restoring) throw new Error("正在读取资源历史，请稍候。");
      if (this.handoffs.size) throw new Error("请等待本次下载交接完成。");
      const code = normalizeCode(query);
      const sources = rankResourceSources(
        this.sources.filter((source) => this.snapshot.selected.includes(source.id)).slice(0, 32),
        this.snapshot.sourcePerformance,
      );
      if (!sources.length) throw new Error("暂无可用的资源查找配置。");
      this.cancel();
      this.revision++;
      this.handles.clear();
      this.workId = workId;
      this.snapshot = {
        ...this.snapshot,
        query,
        code,
        workId,
        rows: [],
        error: "",
        completed: 0,
        total: sources.length,
        cancelled: false,
      };
      this.pendingSources = sources;
      this.startNextSource();
      this.publish();
      this.savePreferences();
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        error: error instanceof Error ? error.message : "无法开始查找。",
      };
      this.publish();
    }
  };
  matches = (code: string, workId?: string) => {
    try {
      return this.snapshot.code === normalizeCode(code) && this.workId === workId;
    } catch {
      return false;
    }
  };
  private startNextSource() {
    // 各来源并行查找，按隐藏实例上限提交，其余来源在有空位时依次补上。
    while (!this.stopped && this.handles.size < bounds.webviews && this.pendingSources.length)
      this.startSource(this.pendingSources.shift()!);
  }
  private startSource(source: ResourceSource) {
    const revision = this.revision;
    const code = this.snapshot.code,
      workId = this.workId;
    const handle = this.resolution.submit(sourceRequest(source, this.snapshot.code));
    const row: ResourceRow = {
      sourceId: source.id,
      sourceName: source.name,
      taskId: handle.id,
      state: "queued",
      handingOff: false,
      added: false,
    };
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.some((item) => item.sourceId === source.id)
        ? this.snapshot.rows.map((item) => (item.sourceId === source.id ? row : item))
        : [...this.snapshot.rows, row],
    };
    this.handles.set(source.id, handle);
    void handle.result.then((outcome) => {
      if (this.revision !== revision || this.handles.get(source.id) !== handle) return;
      this.handles.delete(source.id);
      // 只统计真正完成的查找；取消、清理及本地排队问题不惩罚来源。
      if (
        outcome.ok ||
        !["cancelled", "cleanup_failed", "unavailable", "limit_exceeded", "invalid_input"].includes(
          outcome.code,
        )
      ) {
        const previous = this.snapshot.sourcePerformance[source.id] ?? {
          attempts: 0,
          successes: 0,
          lastSuccessAt: 0,
        };
        this.snapshot = {
          ...this.snapshot,
          sourcePerformance: {
            ...this.snapshot.sourcePerformance,
            [source.id]: {
              attempts: previous.attempts + 1,
              successes: previous.successes + Number(outcome.ok),
              lastSuccessAt: outcome.ok ? Date.now() : previous.lastSuccessAt,
            },
          },
        };
        this.savePreferences();
      }
      this.snapshot = {
        ...this.snapshot,
        completed: this.snapshot.completed + 1,
        rows: this.snapshot.rows.map((item) =>
          item.taskId !== handle.id
            ? item
            : {
                ...item,
                state: outcome.ok
                  ? "succeeded"
                  : outcome.code === "cancelled"
                    ? "cancelled"
                    : "failed",
                stream: outcome.ok ? outcome.streams[0] : undefined,
                error: outcome.ok ? undefined : outcome.message,
              },
        ),
      };
      if (outcome.ok)
        void this.remember({
          code,
          workId,
          sourceId: source.id,
          sourceName: source.name,
          stream: outcome.streams[0]!,
        }).catch(() => {
          this.snapshot = {
            ...this.snapshot,
            storageError: "资源已找到，但历史保存失败；请检查数据目录后重新查找。",
          };
          this.publish();
        });
      if (!outcome.ok && ["cleanup_failed", "unavailable"].includes(outcome.code)) {
        this.pendingSources = [];
        this.snapshot = {
          ...this.snapshot,
          error: "资源查找暂时停止，请处理运行环境或清理问题后重试。",
        };
      }
      this.startNextSource();
      this.publish();
    });
  }
  retry = (sourceId: string) => {
    if (this.stopped || this.snapshot.searching || this.handles.has(sourceId) || this.handoffs.size)
      return;
    const source = this.sources.find((item) => item.id === sourceId);
    if (!source || !this.snapshot.code) return;
    this.startSource(source);
    this.publish();
  };
  /** 详情页挂载期间持有对应番号；最后一个详情关闭后取消该番号仍在进行的查找。 */
  holdView = (code: string, workId?: string) => {
    let key: string;
    try {
      key = `${normalizeCode(code)}
${workId ?? ""}`;
    } catch {
      return () => {};
    }
    this.views.set(key, (this.views.get(key) ?? 0) + 1);
    return () => {
      const left = (this.views.get(key) ?? 1) - 1;
      if (left > 0) {
        this.views.set(key, left);
        return;
      }
      this.views.delete(key);
      // StrictMode 和切换详情会先卸载再挂载，延后一拍确认确实没有详情在显示。
      setTimeout(() => {
        if (!this.views.has(key) && this.snapshot.searching && this.matches(code, workId))
          this.cancel();
      }, 0);
    };
  };
  cancel = () => {
    this.pendingSources = [];
    this.snapshot = { ...this.snapshot, cancelled: true };
    // “取消查找”只停止剩余取流，不打断已点击的复制或下载交接。
    for (const source of this.sources) this.handles.get(source.id)?.cancel();
    this.publish();
  };
  retryCleanup = () => this.resolution.retryCleanup();
  copyResult = (sourceId: string): Promise<string> => {
    const row = this.snapshot.rows.find((item) => item.sourceId === sourceId);
    if (!row?.stream) return Promise.reject(new Error("资源尚未就绪，请重新查找。"));
    return this.useSaved(
      {
        id: row.taskId,
        sourceId,
        sourceName: row.sourceName,
        code: this.snapshot.code,
        workId: this.workId,
        savedAt: 0,
        stream: row.stream,
      },
      "copy",
    );
  };
  addDownload = (sourceId: string): Promise<void> => {
    const row = this.snapshot.rows.find((item) => item.sourceId === sourceId);
    if (!row?.stream || row.handingOff || row.added || this.stopped) return Promise.resolve();
    const patch = (value: Partial<ResourceRow>) => {
      this.snapshot = {
        ...this.snapshot,
        rows: this.snapshot.rows.map((item) =>
          item.taskId === row.taskId ? { ...item, ...value } : item,
        ),
      };
      this.publish();
    };
    patch({ handingOff: true, error: undefined });
    const code = this.snapshot.code,
      workId = this.workId;
    const job = (async () => {
      try {
        // 签名链接在点击下载时重新检查；只传递公开上下文，不泄露 Cookie/Authorization。
        const check = this.resolution.submit({
          url: row.stream!.manifestUrl,
          provider: "direct-hls",
          publicHeaders: row.stream!.context.publicHeaders,
          preferProxy: row.stream!.context.preferProxy,
        });
        this.handles.set(`download:${sourceId}`, check);
        const result = await check.result;
        this.handles.delete(`download:${sourceId}`);
        if (!result.ok) throw new Error(result.message);
        if (this.stopped) throw new Error("资源查找服务正在退出。");
        const stream = result.streams[0]!;
        await this.downloads.add({
          urls: [stream.manifestUrl],
          kind: "hls",
          name: code,
          directory: this.downloads.directory(),
          headers: { ...stream.context.publicHeaders },
          workId,
        });
        patch({
          added: true,
          stream: { ...stream, discoveredBy: "webview", pageUrl: row.stream!.pageUrl },
        });
        await this.remember({
          code,
          workId,
          sourceId,
          sourceName: row.sourceName,
          stream: { ...stream, discoveredBy: "webview", pageUrl: row.stream!.pageUrl },
        }).catch(() => {
          this.snapshot = { ...this.snapshot, storageError: "已加入下载，但资源历史更新失败。" };
          this.publish();
        });
      } catch (error) {
        patch({ error: error instanceof Error ? error.message : "加入下载失败，请重试。" });
        throw error;
      } finally {
        this.handles.delete(`download:${sourceId}`);
        patch({ handingOff: false });
      }
    })();
    this.handoffs.add(job);
    void job.then(
      () => this.handoffs.delete(job),
      () => this.handoffs.delete(job),
    );
    return job;
  };
  async shutdown() {
    this.stopped = true;
    clearTimeout(this.preferenceTimer);
    const active = [...this.handles.values()].map((handle) => handle.result);
    this.cancel();
    for (const handle of this.handles.values()) handle.cancel();
    await this.restoring;
    await Promise.allSettled(active);
    await Promise.allSettled([...this.handoffs]);
    await Promise.allSettled([...this.writes]);
    await this.flushPreferences();
    this.unsubscribe();
    this.snapshot = { ...this.snapshot, available: false };
    this.publish();
  }
}
