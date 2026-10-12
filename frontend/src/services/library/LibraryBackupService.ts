import type { BackupInfo, BackupOperation, BackupStatus } from "../../contracts/libraryBackup";
import type { LibraryPort } from "./LibraryService";
import { LibraryRequestTimeoutError, libraryError } from "./LibraryService";
import { Observable } from "../metadata/shared";

export class LibraryBackupService extends Observable<
  BackupStatus & {
    available: boolean;
    cancelling: boolean;
    candidate?: BackupInfo;
  }
> {
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private starting?: Promise<void>;
  private stopped = false;
  private refreshed = "";
  private request?: { id: string; operation: BackupOperation } & Record<string, string>;
  constructor(
    private port?: Pick<LibraryPort, "request">,
    private before: (operation: BackupOperation) => Promise<void> = async () => {},
    private afterRestore: () => Promise<void> = async () => {},
  ) {
    super({ state: "idle", available: !!port, cancelling: false });
  }
  create(directory: string) {
    return this.start("create", { directory });
  }
  inspect(path: string) {
    return this.start("inspect", { path });
  }
  restore() {
    if (!this.snapshot.candidate) return Promise.resolve();
    return this.start("restore", { path: this.snapshot.candidate.path });
  }
  private async start(operation: BackupOperation, params: Record<string, string>) {
    if (!this.port || this.stopped || this.starting || this.snapshot.state === "running") return;
    const id = crypto.randomUUID();
    this.request = { id, operation, ...params };
    this.publish({
      state: "running",
      id,
      operation,
      phase: "preparing",
      processed: 0,
      total: 0,
      error: "",
      warning: "",
      result: undefined,
      cancelling: false,
      ...(operation !== "restore" ? { candidate: undefined } : {}),
    });
    const work = (async () => {
      try {
        await this.before(operation);
        if (this.snapshot.cancelling || this.stopped) {
          this.publish({ state: "cancelled", cancelling: false });
          return;
        }
        await this.port!.request("library.backup.start", this.request);
        if (this.snapshot.cancelling) await this.port!.request("library.backup.cancel", { id });
      } catch (error) {
        this.publish({ error: libraryError(error) });
        if (!(error instanceof LibraryRequestTimeoutError)) {
          this.publish({ state: "failed", cancelling: false });
          return;
        }
        // A lost response does not mean the native operation was rejected. Keep querying its ID.
      }
      await this.poll();
    })();
    this.starting = work;
    try {
      await work;
    } finally {
      this.starting = undefined;
    }
  }
  private poll() {
    if (!this.port || this.stopped) return Promise.resolve();
    return (this.polling ??= this.load().finally(() => {
      this.polling = undefined;
    }));
  }
  private async load() {
    try {
      const state = await this.port!.request<BackupStatus>("library.backup.status");
      if (state.id !== this.snapshot.id) {
        if (this.request) {
          // Reconcile a lost start acknowledgement with the same idempotency key.
          try {
            await this.port!.request("library.backup.start", this.request);
          } catch (error) {
            if (!(error instanceof LibraryRequestTimeoutError))
              this.publish({ state: "failed", cancelling: false });
            throw error;
          }
          if (this.snapshot.cancelling)
            await this.port!.request("library.backup.cancel", { id: this.snapshot.id });
        }
        return;
      }
      this.publish({ ...state, cancelling: state.state === "running" && this.snapshot.cancelling });
      if (state.state === "completed") {
        if (state.operation === "inspect") this.publish({ candidate: state.result });
        if (state.operation === "restore" && this.refreshed !== state.id) {
          this.refreshed = state.id!;
          this.publish({ candidate: undefined });
          try {
            await this.afterRestore();
          } catch {
            this.publish({ warning: "片库已恢复，刷新未完成。请重启应用读取恢复后的数据。" });
          }
        }
      }
    } catch (error) {
      this.publish({ error: libraryError(error) });
    } finally {
      if (!this.stopped && this.snapshot.state === "running") {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.poll(), this.snapshot.error ? 1500 : 500);
      }
    }
  }
  async cancel() {
    if (!this.port || this.snapshot.state !== "running") return;
    this.publish({ cancelling: true });
    if (this.starting) return;
    try {
      await this.port.request("library.backup.cancel", { id: this.snapshot.id });
    } catch (error) {
      this.publish({ error: libraryError(error), cancelling: false });
    }
  }
  async shutdown() {
    clearTimeout(this.timer);
    await this.starting;
    if (this.snapshot.state === "running") {
      await this.cancel();
      const deadline = Date.now() + 15000;
      while (this.snapshot.state === "running" && Date.now() < deadline) {
        await this.poll();
        if (this.snapshot.state === "running")
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.snapshot.state === "running")
        throw new Error("片库备份或恢复尚未停止，请稍后重试退出。");
    }
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
