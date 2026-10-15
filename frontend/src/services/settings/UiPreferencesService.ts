import { migrateSettings, Observable } from "../metadata/shared";
import type { Store } from "../metadata/shared";

export interface UiPreferences {
  colorScheme: "light" | "dark" | "auto";
  cardClickToPlay: boolean;
  navCollapsed: boolean;
  discoverCardWidth: number;
}

export const discoverCardWidth = { min: 140, max: 640, fallback: 260 };

function validate(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") throw new Error("界面偏好格式无效");
  const data = value as Partial<UiPreferences>;
  if (
    !["light", "dark", "auto"].includes(data.colorScheme ?? "") ||
    typeof data.cardClickToPlay !== "boolean" ||
    typeof data.navCollapsed !== "boolean" ||
    typeof data.discoverCardWidth !== "number" ||
    !Number.isFinite(data.discoverCardWidth) ||
    data.discoverCardWidth < discoverCardWidth.min ||
    data.discoverCardWidth > discoverCardWidth.max
  )
    throw new Error("界面偏好格式无效");
  return {
    colorScheme: data.colorScheme!,
    cardClickToPlay: data.cardClickToPlay,
    navCollapsed: data.navCollapsed,
    discoverCardWidth: data.discoverCardWidth,
  };
}

export class UiPreferencesService extends Observable<{ value: UiPreferences; error: string }> {
  private committed: UiPreferences;
  private initialized?: Promise<void>;
  private ready = false;
  private needsMigration = false;
  private pending?: Partial<UiPreferences>;
  private saving?: Promise<void>;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private revision = 0;

  constructor(
    private store: Store<UiPreferences>,
    defaults: UiPreferences,
    private readLegacy: () => Partial<UiPreferences> | null,
  ) {
    super({ value: defaults, error: "" });
    this.committed = defaults;
  }

  initialize() {
    return (this.initialized ??= (async () => {
      try {
        const raw = await Promise.resolve().then(() => this.store.read());
        // 官方存储已有值或读取失败时，不用旧版数据覆盖它。
        const legacy = raw === null ? this.readLegacy() : null;
        const value = validate(raw ?? { ...this.committed, ...legacy });
        this.committed = value;
        this.needsMigration = legacy !== null;
        this.ready = true;
        this.publish({ value, error: "" });
      } catch {
        this.publish({ error: "无法读取界面偏好，暂用默认设置；原配置已保留。" });
      } finally {
        if (!this.ready) this.initialized = undefined;
      }
    })());
  }

  update(patch: Partial<UiPreferences>): Promise<void> {
    if (!this.ready)
      return this.initialize().then(() => {
        if (this.ready) return this.update(patch);
      });
    const value = validate({ ...this.snapshot.value, ...patch });
    ++this.revision;
    this.pending = { ...this.pending, ...patch };
    this.publish({ value, error: "" });
    return this.flush();
  }

  flush() {
    return (this.saving ??= (async () => {
      try {
        await this.initialize();
        if (!this.ready) return;
        if (this.needsMigration) {
          try {
            this.committed = validate(await migrateSettings(this.store, () => this.committed));
            this.needsMigration = false;
            this.publish({ value: { ...this.committed, ...this.pending }, error: "" });
          } catch {
            this.pending = undefined;
            this.publish({
              value: this.committed,
              error: "界面偏好迁移失败，原配置已保留，请重试。",
            });
            return;
          }
        }
        // 至多一个正在写入的值和一个最新待写值，快速切换不会积压请求。
        while (this.pending) {
          const patch = this.pending;
          const value = validate({ ...this.committed, ...patch });
          this.pending = undefined;
          try {
            await this.store.write(value);
            this.committed = value;
            if (!this.pending) this.publish({ value, error: "" });
          } catch {
            // 等待写入期间 update 可以补入新修改，不能依赖 await 前的类型收窄。
            const pending = this.pending as Partial<UiPreferences> | undefined;
            if (pending) this.pending = { ...patch, ...pending };
            else
              this.publish({
                value: this.committed,
                error: "界面偏好保存失败，已恢复上次设置，请重试。",
              });
          }
        }
      } finally {
        this.saving = undefined;
      }
    })());
  }

  refresh() {
    this.refreshAgain = true;
    return (this.refreshing ??= (async () => {
      try {
        await this.initialize();
        if (!this.ready) return;
        do {
          this.refreshAgain = false;
          if (this.pending || this.saving) return;
          const revision = this.revision;
          try {
            const raw = await this.store.read();
            if (raw === null || this.pending || this.saving || revision !== this.revision) continue;
            this.committed = validate(raw);
            this.needsMigration = false;
            this.publish({ value: this.committed, error: "" });
          } catch {
            if (!this.pending && !this.saving && revision === this.revision)
              this.publish({ error: "无法同步界面偏好，仍保留当前设置。" });
          }
        } while (this.refreshAgain);
      } finally {
        this.refreshing = undefined;
      }
    })());
  }
}
