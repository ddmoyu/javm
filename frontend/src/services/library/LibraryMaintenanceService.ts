import { defaultAdRules } from "../../contracts/maintenance";
import type {
  AdRules,
  MaintenanceCommand,
  MaintenanceMode,
  MaintenancePage,
  MaintenanceVideo,
  RemovalPlan,
  RemovalTarget,
  WorkRemovalPreview,
} from "../../contracts/maintenance";
import type { LibraryPort } from "./LibraryService";
import { normalizeKeywords } from "./maintenanceRules";
import { logEvent } from "../logging/events";

const emptyPage: MaintenancePage = {
  rows: [],
  total: 0,
  groups: 0,
  selected: 0,
  suggested: 0,
  suggestedBytes: 0,
  selectedBytes: 0,
  review: 0,
  unprotected: 0,
  unhashed: 0,
  page: 1,
};
export interface MaintenanceSnapshot extends MaintenancePage {
  mode: MaintenanceMode;
  phase: "idle" | "reading" | "ready" | "cleaning";
  processed: number;
  removalTotal: number;
  error: string;
  message: string;
  failures: string[];
  rules: AdRules;
  settingsReady: boolean;
  changing: boolean;
  cancelling: boolean;
}
interface SettingsStore {
  read(): Promise<unknown>;
  write(value: AdRules): Promise<void>;
}
function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "操作失败，请重试";
}

export class LibraryMaintenanceService {
  private snapshot: MaintenanceSnapshot = {
    ...emptyPage,
    mode: "duplicates",
    phase: "idle",
    processed: 0,
    removalTotal: 0,
    error: "",
    message: "",
    failures: [],
    rules: defaultAdRules,
    settingsReady: false,
    changing: false,
    cancelling: false,
  };
  private listeners = new Set<() => void>();
  private worker?: Worker;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private sequence = 0;
  private generation = 0;
  private settings?: Promise<void>;
  private running?: Promise<void>;
  private cancelled = false;
  private stopped = false;
  constructor(
    private port: Pick<LibraryPort, "request">,
    private files: { remove(path: string): Promise<void> },
    private store: SettingsStore,
    private workerFactory: () => Worker,
    private refreshLibrary: () => Promise<void>,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<MaintenanceSnapshot>) {
    if (this.stopped) return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    return (this.settings ??= (async () => {
      try {
        const raw = await this.store.read();
        if (raw !== null) {
          const value = raw as AdRules;
          if (
            !Array.isArray(value?.keywords) ||
            !Array.isArray(value.excludeKeywords) ||
            ![...value.keywords, ...value.excludeKeywords].every(
              (item) => typeof item === "string",
            ) ||
            typeof value.duplicateNames !== "boolean"
          )
            throw new Error("广告筛选设置无法读取，请重新保存规则");
          this.publish({
            rules: {
              keywords: normalizeKeywords(value.keywords),
              excludeKeywords: normalizeKeywords(value.excludeKeywords),
              duplicateNames: value.duplicateNames,
            },
          });
        }
      } catch (error) {
        logEvent("error", "settings", "maintenance_rules_failed", message(error));
        this.publish({ error: message(error) });
      } finally {
        this.publish({ settingsReady: true });
      }
    })());
  }
  async saveRules(rules: AdRules) {
    if (this.snapshot.phase === "cleaning" || this.snapshot.changing) return;
    this.publish({ changing: true });
    try {
      await this.initialize();
      const normalized = {
        ...rules,
        keywords: normalizeKeywords(rules.keywords),
        excludeKeywords: normalizeKeywords(rules.excludeKeywords),
      };
      if (
        [...normalized.keywords, ...normalized.excludeKeywords].some((word) => word.length > 200) ||
        normalized.keywords.length + normalized.excludeKeywords.length > 500
      )
        throw new Error("关键词最多 500 项，每项最多 200 个字符");
      await this.store.write(normalized);
      this.publish({ rules: normalized, error: "" });
      await this.scan("ads");
    } catch (error) {
      this.publish({ error: message(error) });
      throw error;
    } finally {
      this.publish({ changing: false });
    }
  }
  private terminate() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("检查已停止"));
    this.pending.clear();
  }
  private connect() {
    this.terminate();
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<{ id: number; result: unknown; error?: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.result);
    };
    worker.onerror = () => {
      this.terminate();
      logEvent("error", "library", "maintenance_worker_failed", "后台检查失败，请重新检查");
      this.publish({ phase: "idle", error: "后台检查失败，请重新检查", changing: false });
    };
  }
  private call<T>(command: MaintenanceCommand): Promise<T> {
    if (!this.worker) return Promise.reject(new Error("请先重新检查"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker!.postMessage({ id, command });
    });
  }
  async scan(mode = this.snapshot.mode) {
    if (this.stopped || this.snapshot.phase === "cleaning") return;
    const generation = ++this.generation;
    this.publish({
      ...emptyPage,
      mode,
      phase: "reading",
      processed: 0,
      error: "",
      message: "",
      failures: [],
      cancelling: false,
    });
    try {
      await this.initialize();
      if (generation !== this.generation || this.stopped) return;
      this.connect();
      await this.call({ type: "reset", mode, rules: this.snapshot.rules });
      if (generation !== this.generation || this.stopped) return;
      let after = "",
        revision: number | undefined,
        count = 0;
      while (generation === this.generation && !this.stopped) {
        const result = await this.port.request<{ items: MaintenanceVideo[]; revision: number }>(
          "library.maintenance.read",
          { after, health: mode === "health", ...(revision === undefined ? {} : { revision }) },
        );
        if (generation !== this.generation || this.stopped) return;
        revision = result.revision;
        await this.call({ type: "append", rows: result.items });
        if (generation !== this.generation || this.stopped) return;
        count += result.items.length;
        if (count > 100_000) throw new Error("单次检查最多 10 万个资源，请分库处理后重试。");
        this.publish({ processed: count });
        if (result.items.length < 500) break;
        after = result.items.at(-1)!.id;
      }
      if (generation !== this.generation || this.stopped) return;
      const result = await this.call<MaintenancePage>({ type: "finish" });
      if (generation === this.generation && !this.stopped)
        this.publish({ ...result, phase: "ready" });
    } catch (error) {
      if (generation === this.generation && !this.stopped) {
        logEvent("error", "library", "maintenance_scan_failed", message(error));
        this.publish({ phase: "idle", error: message(error) });
      }
    }
  }
  cancel() {
    if (this.snapshot.phase === "cleaning") {
      this.cancelled = true;
      this.publish({ cancelling: true });
      return;
    }
    ++this.generation;
    this.terminate();
    this.publish({ phase: "idle", changing: false, message: "检查已停止" });
  }
  async change(command: Extract<MaintenanceCommand, { type: "page" | "select" }>) {
    if (this.snapshot.phase !== "ready" || this.snapshot.changing) return false;
    this.publish({ changing: true });
    try {
      this.publish(await this.call<MaintenancePage>(command));
      return true;
    } catch (error) {
      logEvent("error", "library", "maintenance_change_failed", message(error));
      this.publish({ error: message(error) });
      return false;
    } finally {
      this.publish({ changing: false });
    }
  }
  remove(metadataOnly: boolean) {
    if (
      this.running ||
      this.snapshot.phase !== "ready" ||
      !this.snapshot.selected ||
      this.snapshot.changing
    )
      return Promise.resolve();
    if (!metadataOnly && this.snapshot.mode === "duplicates" && this.snapshot.unprotected) {
      this.publish({
        error: "每组、每个分段请至少保留一个可用视频，取消勾选要保留的文件后再清理。",
      });
      return Promise.resolve();
    }
    this.cancelled = false;
    this.publish({
      phase: "cleaning",
      processed: 0,
      error: "",
      failures: [],
      message: "",
      cancelling: false,
    });
    this.running = this.removeSelected(metadataOnly).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  /** 单资源入口仍经过与批量清理相同的逐文件身份复核。 */
  removeResource(video: RemovalTarget) {
    return this.removeItem("prepare", { ...video, metadataOnly: false });
  }
  previewWorkRemoval(id: string) {
    if (this.stopped) return Promise.reject(new Error("媒体服务已停止。"));
    return this.port.request<WorkRemovalPreview>("library.maintenance.previewWork", { id });
  }
  removeWork(preview: WorkRemovalPreview) {
    return this.removeItem("prepareWork", { id: preview.id, expected: preview });
  }
  private async removeItem(method: "prepare" | "prepareWork", params: object) {
    if (
      this.stopped ||
      this.running ||
      this.snapshot.phase === "reading" ||
      this.snapshot.phase === "cleaning"
    )
      throw new Error("请等待当前媒体检查或清理结束。");
    const token = crypto.randomUUID();
    this.cancelled = false;
    const job = (async () => {
      this.publish({
        phase: "cleaning",
        error: "",
        processed: 0,
        removalTotal: 0,
        cancelling: false,
      });
      try {
        const plan = await this.port.request<RemovalPlan>(`library.maintenance.${method}`, {
          token,
          ...params,
        });
        this.publish({ removalTotal: plan.files.length });
        let processed = 0;
        let published = performance.now();
        for (const file of plan.files) {
          if (this.cancelled || this.stopped)
            throw new Error("资源删除已停止，请重新扫描目录核对已完成的操作。");
          const checked = await this.port.request<{ exists: boolean }>(
            "library.maintenance.checkFile",
            { token, path: file.path },
          );
          if (this.cancelled || this.stopped)
            throw new Error("删除已停止，部分文件可能已经删除，请重新核对清单。");
          if (checked.exists) await this.files.remove(file.path);
          ++processed;
          if (performance.now() - published >= 100 || processed === plan.files.length) {
            this.publish({ processed });
            published = performance.now();
          }
        }
        if (this.cancelled || this.stopped)
          throw new Error("删除已停止，部分文件可能已经删除，请重新核对清单。");
        await this.port.request("library.maintenance.complete", { token });
      } finally {
        try {
          await this.port.request("library.maintenance.abort", { token });
        } finally {
          try {
            await this.refreshLibrary();
          } finally {
            this.publish({ phase: "idle", cancelling: false });
          }
        }
      }
    })();
    this.running = job;
    try {
      await job;
    } finally {
      this.running = undefined;
    }
  }
  private async removeSelected(metadataOnly: boolean) {
    const requireRetainedCopy = !metadataOnly && this.snapshot.mode === "duplicates";
    let done = 0,
      failed = 0,
      preserved = 0;
    const failures: string[] = [];
    try {
      while (!this.cancelled) {
        const batch = await this.call<RemovalTarget[]>({
          type: "selected",
          after: failed,
        });
        if (!batch.length) break;
        const removed: string[] = [];
        for (const video of batch) {
          if (this.cancelled) break;
          const token = crypto.randomUUID();
          try {
            const plan = await this.port.request<RemovalPlan>("library.maintenance.prepare", {
              token,
              ...video,
              metadataOnly,
              requireRetainedCopy,
            });
            for (const file of plan.files) {
              const checked = await this.port.request<{ exists: boolean }>(
                "library.maintenance.checkFile",
                { token, path: file.path },
              );
              if (checked.exists) await this.files.remove(file.path);
            }
            await this.port.request("library.maintenance.complete", { token });
            preserved += plan.preserved;
            ++done;
            removed.push(video.id);
          } catch (error) {
            ++failed;
            if (failures.length < 20) failures.push(`${video.path}：${message(error)}`);
          } finally {
            // prepare 超时后也撤销同一 token，防止残留写锁。
            await this.port.request("library.maintenance.abort", { token });
          }
          this.publish({ processed: done + failed, failures: [...failures] });
        }
        this.publish(await this.call<MaintenancePage>({ type: "removed", ids: removed }));
      }
    } catch (error) {
      if (!this.cancelled) logEvent("error", "library", "maintenance_failed", message(error));
      this.publish({ error: message(error) });
    } finally {
      await this.refreshLibrary().catch((error: unknown) => {
        logEvent("error", "library", "maintenance_refresh_failed", message(error));
        this.publish({ error: message(error) });
      });
      const operationError = this.snapshot.error;
      this.publish({ phase: "ready" });
      // 清理后重新分组，避免只剩一部的组或已不重名的广告候选继续显示。
      if (!this.stopped) await this.scan();
      this.publish({
        cancelling: false,
        failures,
        error: operationError || this.snapshot.error,
        message: `${this.cancelled ? "已停止，" : ""}${metadataOnly ? "已清除资料" : "已删除"} ${done} 项，失败 ${failed} 项${preserved ? `，保留 ${preserved} 个共享或目录外文件` : ""}。`,
      });
    }
  }
  async shutdown() {
    this.cancelled = true;
    ++this.generation;
    this.stopped = true;
    await this.running;
    this.terminate();
  }
}
