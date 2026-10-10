import type { NewDownload } from "../../contracts/downloads";
import type {
  ResolutionHandle,
  ResolutionState,
  ResolvedStream,
} from "../../contracts/streamResolution";
import type { ResolutionService } from "./ResolutionService";
import { normalizeCode, resourceSources, sourceRequest } from "./sources";
import type { ResourceSource } from "./sources";

export interface ResourceRow {
  sourceId: string;
  sourceName: string;
  taskId: string;
  state: ResolutionState;
  stream?: ResolvedStream;
  error?: string;
  handingOff: boolean;
  added: boolean;
}
export interface ResourceSearchSnapshot {
  available: boolean;
  query: string;
  code: string;
  selected: string[];
  filter: "all" | "found" | "failed";
  busy: boolean;
  rows: ResourceRow[];
  error: string;
  cleanupPending: number;
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
  constructor(
    private readonly resolution: ResolutionService,
    private readonly downloads: ResourceDownloadPort,
    readonly sources: readonly ResourceSource[] = resourceSources,
  ) {
    this.snapshot = {
      available: resolution.getSnapshot().webviewAvailable,
      query: "",
      code: "",
      selected: sources.slice(0, 3).map((source) => source.id),
      filter: "all",
      busy: false,
      rows: [],
      error: "",
      cleanupPending: 0,
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
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish() {
    this.snapshot = { ...this.snapshot, busy: this.handles.size > 0 };
    for (const listener of this.listeners) listener();
  }
  setQuery = (query: string) => {
    this.snapshot = { ...this.snapshot, query: query.slice(0, 80) };
    this.publish();
  };
  setSources = (selected: string[]) => {
    this.snapshot = {
      ...this.snapshot,
      selected: [...new Set(selected)]
        .filter((id) => this.sources.some((s) => s.id === id))
        .slice(0, 5),
    };
    this.publish();
  };
  setFilter = (filter: ResourceSearchSnapshot["filter"]) => {
    this.snapshot = { ...this.snapshot, filter };
    this.publish();
  };
  search = (query = this.snapshot.query, workId?: string) => {
    this.snapshot = { ...this.snapshot, query: query.slice(0, 80) };
    try {
      if (this.stopped || !this.snapshot.available)
        throw new Error("请在 Windows 桌面应用中查找资源。");
      if (this.handoffs.size) throw new Error("请等待本次下载交接完成。");
      const code = normalizeCode(query);
      const sources = this.sources.filter((source) => this.snapshot.selected.includes(source.id));
      if (!sources.length) throw new Error("请至少选择一个来源。");
      this.cancel();
      this.revision++;
      this.handles.clear();
      this.workId = workId;
      this.snapshot = { ...this.snapshot, query, code, rows: [], error: "" };
      for (const source of sources) this.startSource(source);
      this.publish();
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        error: error instanceof Error ? error.message : "无法开始查找。",
      };
      this.publish();
    }
  };
  private startSource(source: ResourceSource) {
    const revision = this.revision;
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
      this.snapshot = {
        ...this.snapshot,
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
      this.publish();
    });
  }
  retry = (sourceId: string) => {
    if (this.stopped || this.handles.has(sourceId) || this.handoffs.size) return;
    const source = this.sources.find((item) => item.id === sourceId);
    if (!source || !this.snapshot.code) return;
    this.startSource(source);
    this.publish();
  };
  cancel = () => {
    for (const handle of this.handles.values()) handle.cancel();
  };
  retryCleanup = () => this.resolution.retryCleanup();
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
      } catch (error) {
        patch({ error: error instanceof Error ? error.message : "加入下载失败，请重试。" });
        throw error;
      } finally {
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
    this.cancel();
    await Promise.allSettled([...this.handoffs]);
    this.unsubscribe();
    this.snapshot = { ...this.snapshot, available: false };
    this.publish();
  }
}
