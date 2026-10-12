import type { LibraryService } from "./LibraryService";
import type { MediaDirectory } from "../../contracts/library";

export interface WatchSettings {
  enabled: boolean;
}
export interface WatchEvent {
  id: number;
  action: string;
  dir: string;
  filename: string;
}
export interface DirectoryWatchPort {
  online?(path: string): Promise<boolean>;
  create(path: string): Promise<number>;
  remove(id: number): Promise<unknown>;
  listen(listener: (event: WatchEvent) => void): Promise<() => Promise<unknown>>;
}
interface WatchSnapshot {
  ready: boolean;
  enabled: boolean;
  changing: boolean;
  watching: number;
  queued: number;
  error: string;
}
/** Native watchers only signal changes; bounded, coalesced scan scheduling stays in TypeScript. */
export class DirectoryWatchService {
  private snapshot: WatchSnapshot = {
    ready: false,
    enabled: false,
    changing: false,
    watching: 0,
    queued: 0,
    error: "",
  };
  private listeners = new Set<() => void>();
  private watches = new Map<string, { id: number; path: string }>();
  private pending = new Map<string, { due: number; first: number; attempts: number }>();
  private lastScan = new Map<string, number>();
  private reconnectScan = new Set<string>();
  private initialized?: Promise<void>;
  private syncing?: Promise<void>;
  private syncDirty = false;
  private pumping?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private unlisten?: () => Promise<unknown>;
  private unsubscribe?: () => void;
  private directoryKey = "";
  private stopped = false;
  constructor(
    private library: Pick<LibraryService, "initialize" | "subscribe" | "getSnapshot" | "scan">,
    private port: DirectoryWatchPort,
    private settings: { read(): Promise<unknown>; write(value: WatchSettings): Promise<void> },
    private blocked: () => boolean = () => false,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<WatchSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...change,
      watching: this.watches.size,
      queued: this.pending.size,
    };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    return (this.initialized ??= (async () => {
      try {
        const value = await this.settings.read();
        if (
          value !== null &&
          (typeof value !== "object" || typeof (value as WatchSettings).enabled !== "boolean")
        )
          throw new Error("目录监听设置无效，请重新保存。");
        await this.library.initialize();
        if (this.stopped) return;
        this.unlisten = await this.port.listen(this.changed);
        this.publish({ enabled: !!(value as WatchSettings | null)?.enabled });
        this.observeLibrary();
        await this.sync();
      } catch (error) {
        this.publish({
          error: error instanceof Error ? error.message : "目录监听初始化失败。",
        });
      } finally {
        this.publish({ ready: true });
      }
    })());
  }
  private observeLibrary() {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.library.subscribe(() => {
      const key = this.library
        .getSnapshot()
        .directories.map((dir) => `${dir.id}:${dir.path}`)
        .join("\n");
      if (key !== this.directoryKey) {
        this.directoryKey = key;
        void this.sync();
      }
      this.schedule();
    });
  }
  async setEnabled(enabled: boolean) {
    await this.initialize();
    if (this.stopped || this.snapshot.changing) return;
    this.publish({ changing: true });
    try {
      if (!this.unlisten) this.unlisten = await this.port.listen(this.changed);
      this.observeLibrary();
      await this.settings.write({ enabled });
      this.publish({ enabled, error: "" });
      if (!enabled) {
        this.pending.clear();
        this.reconnectScan.clear();
      }
      await this.sync();
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "目录监听设置失败。" });
    } finally {
      this.publish({ changing: false });
    }
  }
  private directories(): MediaDirectory[] {
    return this.snapshot.enabled && !this.stopped
      ? this.library.getSnapshot().directories.slice(0, 32)
      : [];
  }
  private sync() {
    this.syncDirty = true;
    if (this.syncing) return this.syncing;
    const work = (async () => {
      do {
        this.syncDirty = false;
        const directories = this.directories();
        const errors: string[] = [];
        for (const key of this.reconnectScan)
          if (!directories.some((dir) => dir.id === key)) this.reconnectScan.delete(key);
        for (const [key, watch] of this.watches) {
          const retained = directories.some((dir) => dir.id === key && dir.path === watch.path);
          if (
            retained &&
            (!this.port.online || (await this.port.online(watch.path).catch(() => false)))
          )
            continue;
          if (retained) this.reconnectScan.add(key);
          try {
            await this.port.remove(watch.id);
            this.watches.delete(key);
            this.pending.delete(key);
            this.lastScan.delete(key);
          } catch {
            errors.push("部分目录监听未停止，请重试关闭。");
          }
        }
        for (const dir of directories) {
          if (this.stopped || !this.snapshot.enabled) break;
          if (this.watches.has(dir.id)) continue;
          try {
            const id = await this.port.create(dir.path);
            this.watches.set(dir.id, { id, path: dir.path });
            if (this.reconnectScan.delete(dir.id)) {
              const now = Date.now();
              // Reconcile changes made while the volume was disconnected, even with no new event.
              this.pending.set(dir.id, { first: now, due: now, attempts: 0 });
            }
          } catch {
            errors.push(`无法监听 ${dir.path}，请确认目录在线。`);
          }
        }
        if (this.snapshot.enabled && this.library.getSnapshot().directories.length > 32)
          errors.push("最多自动监听 32 个目录，其余目录请手动扫描。");
        this.publish({ error: errors.slice(0, 4).join("\n") });
        this.schedule();
      } while (this.syncDirty);
    })();
    this.syncing = work;
    void work.finally(() => {
      this.syncing = undefined;
      clearTimeout(this.retryTimer);
      if (!this.stopped && this.snapshot.enabled)
        this.retryTimer = setTimeout(() => {
          void this.sync();
        }, 60_000);
    });
    return work;
  }
  private changed = (event: WatchEvent) => {
    if (
      this.stopped ||
      !this.snapshot.enabled ||
      /(?:\.part|\.tmp|\.javm-tmp)$/i.test(event.filename)
    )
      return;
    const directory = this.directories().find((dir) => this.watches.get(dir.id)?.id === event.id);
    if (!directory) return;
    // Non-recursive library roots ignore nested file events from the recursive host watcher.
    const normalize = (value: string) =>
      value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    if (!directory.recursive && normalize(event.dir) !== normalize(directory.path)) return;
    const now = Date.now(),
      previous = this.pending.get(directory.id);
    this.pending.set(directory.id, {
      first: previous?.first ?? now,
      attempts: previous?.attempts ?? 0,
      due: Math.max(
        Math.min(now + 2000, (previous?.first ?? now) + 30_000),
        (this.lastScan.get(directory.id) ?? 0) + 10_000,
      ),
    });
    this.publish();
    this.schedule();
  };
  private schedule() {
    if (this.stopped || !this.snapshot.enabled || !this.pending.size || this.timer || this.pumping)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, 1000);
  }
  private pump() {
    if (this.pumping) return this.pumping;
    const work = (async () => {
      if (
        this.stopped ||
        !this.snapshot.enabled ||
        this.blocked() ||
        this.library.getSnapshot().scan?.state === "scanning"
      )
        return;
      const entry = [...this.pending].find(([, value]) => value.due <= Date.now());
      if (!entry) return;
      const [id, value] = entry;
      this.pending.delete(id);
      this.lastScan.set(id, Date.now());
      this.publish();
      try {
        await this.library.scan(id);
      } catch {
        if (
          ++value.attempts < 3 &&
          this.snapshot.enabled &&
          !this.stopped &&
          this.watches.has(id)
        ) {
          this.pending.set(id, { ...value, due: Date.now() + value.attempts * 10_000 });
        }
        this.publish({ error: "自动扫描未完成，请检查目录状态；连续失败后可手动重新扫描。" });
      }
    })();
    this.pumping = work;
    void work.finally(() => {
      this.pumping = undefined;
      this.publish();
      this.schedule();
    });
    return work;
  }
  async shutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.unsubscribe?.();
    this.pending.clear();
    this.reconnectScan.clear();
    await this.initialized;
    this.unsubscribe?.();
    await this.pumping;
    await this.syncing;
    await this.sync();
    await this.unlisten?.();
    this.unlisten = undefined;
    if (this.watches.size) throw new Error("目录监听尚未完成清理，请重试退出。");
  }
}
