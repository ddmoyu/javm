import type { FilmLayout } from "../../contracts/library";

interface LayoutStore {
  read(): Promise<unknown>;
  write(value: { layout: FilmLayout }): Promise<void>;
}

interface Snapshot {
  layout: FilmLayout;
  error: string;
}

export class LibraryLayoutService {
  private snapshot: Snapshot = { layout: "poster", error: "" };
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private saving?: Promise<void>;
  private pending?: FilmLayout;
  private changed = false;
  private committed: FilmLayout = "poster";

  constructor(private store: LayoutStore) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  initialize() {
    this.initialized ??= (async () => {
      try {
        const value = await this.store.read();
        if (value === null) return;
        if (
          typeof value !== "object" ||
          !("layout" in value) ||
          (value.layout !== "poster" && value.layout !== "landscape" && value.layout !== "list")
        )
          throw new Error("显示方式设置无效");
        this.committed = value.layout;
        if (!this.changed) this.publish({ layout: value.layout });
      } catch {
        if (!this.changed)
          this.publish({ error: "无法读取上次的显示方式，暂用海报视图。可重新选择并保存。" });
      }
    })();
    return this.initialized;
  }

  setLayout(layout: FilmLayout) {
    this.changed = true;
    this.pending = layout;
    this.publish({ layout, error: "" });
    return this.flush();
  }

  flush() {
    this.saving ??= (async () => {
      try {
        await this.initialize();
        // 只保留一个待写入值，快速切换时最终选择不会被较早的写入覆盖。
        while (this.pending !== undefined) {
          const layout = this.pending;
          this.pending = undefined;
          try {
            await this.store.write({ layout });
            this.committed = layout;
          } catch {
            if (this.pending === undefined)
              this.publish({
                layout: this.committed,
                error: "显示方式保存失败，已恢复上次设置，请重试。",
              });
          }
        }
      } finally {
        this.saving = undefined;
      }
    })();
    return this.saving;
  }
}
