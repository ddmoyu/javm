interface BackgroundSettings {
  runInBackground: boolean;
}

interface BackgroundSettingsStore {
  read(): Promise<unknown>;
  write(settings: BackgroundSettings): Promise<void>;
}

interface Snapshot extends BackgroundSettings {
  ready: boolean;
  available: boolean;
  saving: boolean;
  error: string;
}

export class BackgroundSettingsService {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private saving?: Promise<void>;

  constructor(
    private store: BackgroundSettingsStore,
    available = true,
  ) {
    this.snapshot = { runInBackground: true, ready: false, available, saving: false, error: "" };
  }

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
        const value = this.snapshot.available ? await this.store.read() : null;
        let runInBackground = true;
        if (value !== null) {
          if (
            typeof value !== "object" ||
            !("runInBackground" in value) ||
            typeof value.runInBackground !== "boolean"
          )
            throw new Error("后台运行设置格式无效");
          runInBackground = value.runInBackground;
        }
        this.publish({ runInBackground, ready: true });
      } catch {
        this.publish({ ready: true, error: "无法读取后台运行设置，暂按开启处理；请重新设置。" });
      }
    })();
    return this.initialized;
  }

  async setRunInBackground(enabled: boolean) {
    if (!this.snapshot.available) throw new Error("请在桌面端设置后台运行。");
    if (this.saving) throw new Error("正在保存后台运行设置，请稍候。");
    this.publish({ saving: true });
    this.saving = (async () => {
      try {
        await this.initialize();
        await this.store.write({ runInBackground: enabled });
        this.publish({ runInBackground: enabled, error: "" });
      } catch (error) {
        this.publish({ error: "后台运行设置保存失败，仍使用原设置，请重试。" });
        throw error;
      } finally {
        this.saving = undefined;
        this.publish({ saving: false });
      }
    })();
    return this.saving;
  }

  async shouldRunInBackground() {
    await this.initialize();
    // 点击开关后立即关闭窗口，也要使用本次保存成功的设置。
    await this.saving;
    return this.snapshot.runInBackground;
  }
}
