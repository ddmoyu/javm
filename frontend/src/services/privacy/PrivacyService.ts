import { Observable } from "../metadata/shared";
import type { Store } from "../metadata/shared";
import { shortcutLabel, validateShortcut } from "./shortcuts";
import type { PrivacyShortcut } from "./shortcuts";

export interface PrivacySettings {
  localEnabled: boolean;
  localShortcut: PrivacyShortcut;
  globalEnabled: boolean;
  globalShortcut: PrivacyShortcut;
  lockOnStartup: boolean;
  lockOnBossKey: boolean;
  blurImages: boolean;
  protectRecentFiles: boolean;
}
interface Credential {
  salt: string;
  hash: string;
  iterations: number;
}
export interface PrivacyRecord {
  version: 1;
  settings: PrivacySettings;
  credential: Credential | null;
}
interface Snapshot {
  settings: PrivacySettings;
  ready: boolean;
  locked: boolean;
  hidden: boolean;
  hasPassword: boolean;
  busy: boolean;
  error: string;
  shortcutError: string;
}
export const defaultPrivacySettings: PrivacySettings = {
  localEnabled: true,
  localShortcut: { key: "F1", modifier: "" },
  globalEnabled: true,
  globalShortcut: { key: "F9", modifier: "" },
  lockOnStartup: false,
  lockOnBossKey: false,
  blurImages: false,
  protectRecentFiles: true,
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const decode = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
async function derive(password: string, salt: string, iterations: number) {
  if (!password || password.length > 256) throw new Error("密码长度应为 1 至 256 个字符。");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: decode(salt), iterations, hash: "SHA-256" },
        key,
        256,
      ),
    ),
  );
}
function validateSettings(value: PrivacySettings) {
  if (!value || typeof value !== "object") throw new Error("隐私设置格式无效。");
  for (const key of [
    "localEnabled",
    "globalEnabled",
    "lockOnStartup",
    "lockOnBossKey",
    "blurImages",
    "protectRecentFiles",
  ] as const)
    if (typeof value[key] !== "boolean") throw new Error("隐私设置格式无效。");
  const settings = {
    ...value,
    localShortcut: validateShortcut(value.localShortcut),
    globalShortcut: validateShortcut(value.globalShortcut, true),
  };
  if (
    settings.localEnabled &&
    settings.globalEnabled &&
    shortcutLabel(settings.localShortcut) === shortcutLabel(settings.globalShortcut)
  )
    throw new Error("应用内和全局快捷键不能相同，请选择其他按键。");
  return settings;
}

export class PrivacyService extends Observable<Snapshot> {
  private record: PrivacyRecord = {
    version: 1,
    settings: defaultPrivacySettings,
    credential: null,
  };
  private loading?: Promise<void>;
  private failures = 0;
  private retryAt = 0;
  private concealRevision = 0;
  private hiding?: Promise<void>;
  private hideMainRequested = false;
  getConcealRevision = () => this.concealRevision;
  constructor(
    private store: Store<PrivacyRecord>,
    private register: (settings: PrivacySettings) => Promise<void>,
    private concealWindows: (hidden: boolean) => Promise<void>,
  ) {
    super({
      settings: defaultPrivacySettings,
      ready: false,
      locked: true,
      hidden: false,
      hasPassword: false,
      busy: false,
      error: "",
      shortcutError: "",
    });
  }
  initialize() {
    return (this.loading ??= (async () => {
      try {
        const raw = (await this.store.read()) as PrivacyRecord | null;
        if (raw !== null) {
          if (raw.version !== 1 || !("credential" in raw)) throw new Error("隐私设置格式无效。");
          const settings = validateSettings(raw.settings);
          const credential = raw.credential;
          if (
            credential !== null &&
            (!/^[a-f0-9]{32}$/.test(credential.salt) ||
              !/^[a-f0-9]{64}$/.test(credential.hash) ||
              credential.iterations !== 600000)
          )
            throw new Error("密码记录格式无效。");
          if (!credential && (settings.lockOnStartup || settings.lockOnBossKey))
            throw new Error("密码记录缺失。");
          this.record = { version: 1, settings, credential };
        }
        this.publish({
          settings: this.record.settings,
          ready: true,
          locked: !!this.record.credential && this.record.settings.lockOnStartup,
          hasPassword: !!this.record.credential,
          error: "",
        });
        // 先建立应用内对话框按键；全局键被占用时，应用内老板键仍可使用。
        const registerShortcuts = async () => {
          if (this.record.settings.globalEnabled)
            await this.register({ ...this.record.settings, globalEnabled: false });
          await this.register(this.record.settings);
        };
        await registerShortcuts()
          .then(() => this.publish({ shortcutError: "" }))
          .catch((error: unknown) => {
            this.publish({
              shortcutError:
                error instanceof Error ? error.message : "全局快捷键注册失败，请修改快捷键。",
            });
          });
      } catch {
        this.publish({
          ready: false,
          locked: true,
          error: "无法读取隐私设置。为保护内容，应用保持锁定，请重试；原配置已保留。",
        });
      } finally {
        if (!this.snapshot.ready) this.loading = undefined;
      }
    })());
  }
  private requireReady() {
    if (!this.snapshot.ready || this.snapshot.locked || this.snapshot.hidden)
      throw new Error("请先解锁应用。");
    if (this.snapshot.busy) throw new Error("正在保存或验证，请稍候。");
  }
  async saveSettings(input: PrivacySettings) {
    this.requireReady();
    const settings = validateSettings(input);
    if (!this.record.credential && (settings.lockOnStartup || settings.lockOnBossKey))
      throw new Error("请先设置密码。");
    const previous = this.record.settings;
    this.publish({ busy: true });
    try {
      // 真正注册新按键进行冲突检测；保存失败则恢复旧注册。
      await this.register(settings);
      try {
        await this.store.write({ ...this.record, settings });
      } catch {
        await this.register(previous).catch(() =>
          this.publish({ shortcutError: "设置保存失败，旧全局快捷键恢复失败，请重新设置。" }),
        );
        throw new Error("隐私设置保存失败，原设置已保留。");
      }
      this.record = { ...this.record, settings };
      this.publish({
        settings,
        shortcutError: "",
        locked:
          this.snapshot.locked ||
          (this.snapshot.hidden && settings.lockOnBossKey && this.snapshot.hasPassword),
      });
    } finally {
      this.publish({ busy: false });
    }
  }
  private async verify(password: string) {
    if (Date.now() < this.retryAt) throw new Error("密码错误次数过多，请 30 秒后重试。");
    const credential = this.record.credential;
    if (!credential) throw new Error("尚未设置密码。");
    const actual = await derive(password, credential.salt, credential.iterations);
    let difference = 0;
    for (let i = 0; i < actual.length; ++i)
      difference |= actual.charCodeAt(i) ^ credential.hash.charCodeAt(i);
    if (difference) {
      if (++this.failures >= 5) {
        this.retryAt = Date.now() + 30000;
        this.failures = 0;
      }
      throw new Error("密码不正确。");
    }
    this.failures = 0;
    this.retryAt = 0;
  }
  async changePassword(current: string, next: string | null) {
    this.requireReady();
    if (next !== null && (next.length < 6 || next.length > 256))
      throw new Error("新密码长度应为 6 至 256 个字符。");
    const revision = this.concealRevision;
    this.publish({ busy: true });
    try {
      if (this.record.credential) await this.verify(current);
      const credential =
        next === null
          ? null
          : { salt: hex(crypto.getRandomValues(new Uint8Array(16))), iterations: 600000, hash: "" };
      if (credential) credential.hash = await derive(next!, credential.salt, credential.iterations);
      if (revision !== this.concealRevision) throw new Error("应用已隐藏或锁定，请恢复后重试。");
      const settings = credential
        ? this.record.settings
        : { ...this.record.settings, lockOnStartup: false, lockOnBossKey: false };
      const record: PrivacyRecord = { version: 1, credential, settings };
      await this.store.write(record);
      this.record = record;
      this.publish({
        hasPassword: !!credential,
        settings,
        ...(!credential && this.snapshot.locked ? { locked: false, hidden: true } : {}),
      });
    } finally {
      this.publish({ busy: false });
    }
  }
  async unlock(password: string) {
    if (!this.snapshot.ready || this.snapshot.busy) return;
    const revision = this.concealRevision;
    this.publish({ busy: true });
    try {
      if (this.snapshot.locked) await this.verify(password);
      if (revision !== this.concealRevision) return;
      this.publish({ locked: false, hidden: false });
    } finally {
      this.publish({ busy: false });
    }
  }
  async conceal(lock = false) {
    ++this.concealRevision;
    this.publish({
      hidden: this.snapshot.hidden || !lock,
      locked:
        this.snapshot.locked ||
        (this.snapshot.hasPassword && (lock || this.snapshot.settings.lockOnBossKey)),
    });
    this.hideMainRequested ||= !lock;
    if (!this.hiding)
      this.hiding = (async () => {
        do {
          const hideMain = this.hideMainRequested;
          this.hideMainRequested = false;
          await this.concealWindows(hideMain);
        } while (this.hideMainRequested);
      })()
        .catch(() => {
          this.publish({ error: "部分窗口隐藏失败，内容已遮挡；请检查隐私设置。" });
          throw new Error("部分窗口隐藏失败，内容已遮挡；请检查隐私设置。");
        })
        .finally(() => {
          this.hiding = undefined;
        });
    await this.hiding;
  }
  async restore() {
    const revision = this.concealRevision;
    await this.hiding?.catch(() => {});
    // 托盘和重复启动只能显示锁屏，不能绕过密码验证。
    if (revision !== this.concealRevision) return false;
    if (this.snapshot.ready) this.publish({ hidden: false });
    return true;
  }
}
