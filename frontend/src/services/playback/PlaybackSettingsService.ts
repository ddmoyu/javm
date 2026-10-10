export type PlaybackWindowMode = "reuse" | "new";

export interface PlaybackSettings {
  defaultPlayer: "internal" | "external";
  windowMode: PlaybackWindowMode;
  externalPlayerPath: string;
}

export interface PlaybackStore<T> {
  read(): Promise<unknown>;
  write(value: T): Promise<void>;
}

export const defaultPlaybackSettings: PlaybackSettings = {
  defaultPlayer: "internal",
  windowMode: "reuse",
  externalPlayerPath: "",
};

export function validatePlaybackSettings(value: unknown): PlaybackSettings {
  const input = value as Partial<PlaybackSettings> | null;
  if (
    !input ||
    !["internal", "external"].includes(input.defaultPlayer ?? "") ||
    (input.windowMode !== undefined && !["reuse", "new"].includes(input.windowMode)) ||
    typeof input.externalPlayerPath !== "string"
  )
    throw new Error("播放设置格式无效，请重新保存设置。");
  const path = input.externalPlayerPath.trim();
  if (
    path &&
    (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]).+\.exe$/i.test(path) ||
      /["<>|?*]/.test(path) ||
      Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
      path.length > 4096)
  )
    throw new Error("请选择播放器 .exe 的完整路径，不要附加命令参数。");
  return {
    defaultPlayer: input.defaultPlayer!,
    // 兼容尚未包含窗口模式的已保存偏好。
    windowMode: input.windowMode ?? "reuse",
    externalPlayerPath: path,
  };
}

interface Snapshot {
  settings: PlaybackSettings;
  ready: boolean;
  available: boolean;
  error: string;
}

export class PlaybackSettingsService {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private loading?: Promise<void>;
  private saving = false;
  constructor(
    private store: PlaybackStore<PlaybackSettings>,
    available = true,
    private choose?: () => Promise<string | undefined>,
    private validatePath?: (path: string) => Promise<void>,
  ) {
    this.snapshot = { settings: defaultPlaybackSettings, ready: false, available, error: "" };
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
    this.initialized ??= this.reload();
    return this.initialized;
  }
  reload() {
    this.loading ??= (async () => {
      try {
        const value = this.snapshot.available ? await this.store.read() : null;
        this.publish({
          settings: value === null ? defaultPlaybackSettings : validatePlaybackSettings(value),
          error: "",
          ready: true,
        });
      } catch {
        this.publish({ error: "无法读取播放设置，请重新保存设置。", ready: true });
      }
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  async update(value: PlaybackSettings) {
    if (this.saving) throw new Error("正在保存播放设置，请稍候。");
    if (!this.snapshot.available) throw new Error("请在桌面端保存播放设置。");
    const settings = validatePlaybackSettings(value);
    this.saving = true;
    try {
      await this.initialize();
      await this.loading;
      if (settings.externalPlayerPath) await this.validatePath?.(settings.externalPlayerPath);
      await this.store.write(settings);
      this.publish({ settings, error: "" });
    } finally {
      this.saving = false;
    }
  }
  async choosePlayer() {
    if (!this.snapshot.available || !this.choose) throw new Error("请在桌面端选择播放器。");
    return this.choose();
  }
}
