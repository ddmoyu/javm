import type { LegacyImportSnapshot } from "../../contracts/legacyImport";
import type { LibraryPort } from "./LibraryService";
import { libraryError } from "./LibraryService";

export class LegacyImportService {
  private snapshot: LegacyImportSnapshot & {
    opened: boolean;
    cancelling: boolean;
    checking: boolean;
  } = {
    state: "unchecked",
    opened: false,
    cancelling: false,
    checking: false,
  };
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private checking?: Promise<void>;
  private polling?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private starting = false;
  private refreshed = false;
  constructor(
    private port?: Pick<LibraryPort, "request">,
    private refreshLibrary: () => Promise<void> = async () => {},
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<typeof this.snapshot>) {
    if (this.stopped) return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    return (this.initialized ??= this.check());
  }
  open() {
    if (this.stopped) return Promise.resolve();
    this.publish({ opened: true });
    if (this.starting || this.snapshot.state === "running") return Promise.resolve();
    return this.check();
  }
  private check() {
    if (this.stopped) return Promise.resolve();
    return (this.checking ??= this.loadCandidate().finally(() => {
      this.checking = undefined;
    }));
  }
  private async loadCandidate() {
    if (!this.port) {
      this.publish({ state: "none" });
      return;
    }
    this.publish({ checking: true });
    try {
      const result = await this.port.request<LegacyImportSnapshot>("library.legacy.check");
      this.publish({
        operation: "import",
        removedWorks: undefined,
        sourcePath: undefined,
        targetPath: undefined,
        phase: undefined,
        backupPath: undefined,
        targetBackupPath: undefined,
        currentVideos: undefined,
        warning: "",
        error: "",
        cancelling: false,
        ...result,
        opened: this.snapshot.opened || result.state === "available",
      });
      if (result.state === "running") {
        this.publish({ opened: true });
        this.schedule();
      }
    } catch (error) {
      this.publish({ state: "failed", opened: true, error: libraryError(error) });
    } finally {
      this.publish({ checking: false });
    }
  }
  dismiss() {
    if (this.snapshot.state !== "running" && !this.starting) this.publish({ opened: false });
  }
  async start() {
    if (
      !this.port ||
      this.checking ||
      this.starting ||
      this.snapshot.state === "running" ||
      this.stopped
    )
      return;
    if (!this.snapshot.sourcePath) {
      await this.check();
      return;
    }
    this.starting = true;
    this.refreshed = false;
    this.publish({
      state: "running",
      phase: "preparing",
      processed: 0,
      total: 0,
      error: "",
      cancelling: false,
      opened: true,
    });
    try {
      await this.port.request("library.legacy.start");
      if (this.snapshot.cancelling) await this.port.request("library.legacy.cancel");
    } catch (error) {
      // 请求超时不代表后台未启动；查询真实任务状态后才允许重试。
      this.publish({ error: libraryError(error) });
    } finally {
      this.starting = false;
      await this.poll();
    }
  }
  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), this.snapshot.error ? 1500 : 500);
  }
  private poll() {
    if (!this.port || this.stopped) return Promise.resolve();
    return (this.polling ??= this.load().finally(() => {
      this.polling = undefined;
    }));
  }
  private async load() {
    try {
      const result = await this.port!.request<LegacyImportSnapshot>("library.legacy.status");
      // start 未到达原生端时保留可重试错误，不将 unchecked/available 当作成功。
      if (result.state === "unchecked" || result.state === "available" || result.state === "none") {
        this.publish({ state: "failed", error: this.snapshot.error || "导入尚未开始，请重试。" });
        return;
      }
      this.publish({ ...result, error: result.error ?? "" });
      if (result.state === "completed" && !this.refreshed) {
        this.refreshed = true;
        await this.refreshLibrary();
      }
    } catch (error) {
      // 保持 running，防止响应暂时丢失后再次提交同一导入。
      this.publish({ error: libraryError(error) });
    } finally {
      if (this.snapshot.state === "running") this.schedule();
    }
  }
  async cancel() {
    if (!this.port || this.snapshot.state !== "running" || this.snapshot.cancelling) return;
    this.publish({ cancelling: true });
    if (this.starting) return;
    try {
      await this.port.request("library.legacy.cancel");
    } catch (error) {
      this.publish({ cancelling: false, error: libraryError(error) });
    }
  }
  async shutdown() {
    if (this.snapshot.state === "running") await this.cancel();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
