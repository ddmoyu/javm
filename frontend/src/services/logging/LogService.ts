import { cleanLog } from "./events";
import type { LogEntry, LogInput } from "./events";
import type { RotatingLogStore } from "./RotatingLogStore";

export class LogService {
  private snapshot: { available: boolean; error: string; dropped: number; directory: string };
  private listeners = new Set<() => void>();
  private pending: LogEntry[] = [];
  private sequence = 0;
  private session = crypto.randomUUID();
  private recentEntries: LogEntry[] = [];
  private entryListeners = new Set<(entry: LogEntry) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private maintenance?: ReturnType<typeof setInterval>;
  private stopped = false;
  private reportedDrops = 0;
  private dropped = 0;
  constructor(private store?: RotatingLogStore) {
    this.snapshot = {
      available: !!store,
      error: "",
      dropped: 0,
      directory: store?.port.directory ?? "",
    };
  }
  getSnapshot = () => this.snapshot;
  getSession = () => this.session;
  getRecentEntries = () => this.recentEntries.slice();
  observeEntries(listener: (entry: LogEntry) => void) {
    this.entryListeners.add(listener);
    return () => {
      this.entryListeners.delete(listener);
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    if (!this.store || this.maintenance) return;
    const maintain = () => {
      void this.store!.maintain().catch(() =>
        this.publish({ error: "日志清理失败，请检查日志目录的可用空间和访问权限。" }),
      );
    };
    maintain();
    this.maintenance = setInterval(maintain, 3600000);
  }
  record = (input: LogInput) => {
    if (this.stopped || input.level === "debug") return;
    const entry = {
      ...cleanLog(input),
      time: new Date().toISOString(),
      session: this.session,
      sequence: ++this.sequence,
    };
    this.recentEntries.push(entry);
    if (this.recentEntries.length > 400) this.recentEntries.shift();
    for (const listener of this.entryListeners) {
      try {
        listener(entry);
      } catch {
        /* 诊断订阅者不能影响日志写入。 */
      }
    }
    if (!this.store) return;
    if (this.pending.length >= 500) {
      ++this.dropped;
      if (!this.snapshot.dropped) this.publish({ dropped: this.dropped });
      // 错误优先于普通输出；所有级别共享同一有界队列。
      const disposable = this.pending.findIndex((item) => item.level === "info");
      if (input.level !== "error" || disposable < 0) return;
      this.pending.splice(disposable, 1);
    }
    this.pending.push(entry);
    this.schedule(250);
  };
  private schedule(delay: number) {
    if (!this.timer && !this.stopped)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, delay);
  }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.store) return;
    if (this.writing) {
      await this.writing;
      if (this.snapshot.error || !this.pending.length) return;
      return this.flush();
    }
    const count = this.pending.length;
    this.writing = (async () => {
      try {
        // 每批最多 16 条；序列化和文件访问不会累计整份日志到主线程。
        let remaining = count;
        while (remaining > 0 && this.pending.length) {
          const batch = this.pending.splice(0, Math.min(16, remaining));
          remaining -= batch.length;
          try {
            await this.store!.append(batch);
          } catch (error) {
            this.pending = [...batch, ...this.pending];
            let excess = Math.max(0, this.pending.length - 500);
            this.dropped += excess;
            // 写入期间队列可能已满；重试也优先保留错误，并维持剩余记录的顺序。
            for (const level of ["debug", "info", "warn", "error"] as const) {
              if (!excess) break;
              this.pending = this.pending.filter((entry) => {
                if (excess && entry.level === level) {
                  excess--;
                  return false;
                }
                return true;
              });
            }
            throw error;
          }
        }
        if (this.dropped > this.reportedDrops) {
          const dropped = this.dropped;
          await this.store!.append([
            {
              level: "warn",
              module: "logging",
              event: "queue_overflow",
              message: `日志写入繁忙，累计丢弃 ${dropped} 条记录。`,
              time: new Date().toISOString(),
              session: this.session,
              sequence: ++this.sequence,
            },
          ]);
          this.reportedDrops = dropped;
        }
        if (this.snapshot.error) this.publish({ error: "" });
      } catch {
        this.publish({ error: "日志写入失败，正在有限重试。请检查磁盘空间和日志目录权限。" });
        this.schedule(10000);
      }
    })().finally(() => {
      this.writing = undefined;
      if (this.snapshot.dropped !== this.dropped) this.publish({ dropped: this.dropped });
      if (this.pending.length) this.schedule(250);
    });
    await this.writing;
  };
  async recent() {
    await this.flush();
    return this.store ? this.store.recent() : [];
  }
  async openDirectory() {
    await this.store?.maintain();
    await this.store?.port.openDirectory();
  }
  async shutdown() {
    this.stopped = true;
    clearInterval(this.maintenance);
    clearTimeout(this.timer);
    await this.flush();
  }
}
