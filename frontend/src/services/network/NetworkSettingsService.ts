import { defaultNetworkSettings, validateNetworkSettings } from "../../contracts/network";
import type { NetworkSettings } from "../../contracts/network";
import { StopUnconfirmedError } from "../downloads/ports";

export type ProxyProbe = (proxy: string, signal: AbortSignal) => Promise<{ elapsedMs: number }>;

interface ProxyTestResult {
  proxy: string;
  status: "success" | "failed" | "cancelled";
  message: string;
}

export interface NetworkSettingsStore {
  read(): Promise<unknown>;
  write(settings: NetworkSettings): Promise<void>;
}

interface Snapshot {
  settings: NetworkSettings;
  ready: boolean;
  available: boolean;
  error: string;
  testing: boolean;
  testResult: ProxyTestResult | null;
}

export class NetworkSettingsService {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private saved = false;
  private activeTest?: { abort: AbortController; done: Promise<unknown> };
  private stopPending?: () => Promise<void>;
  private stopped = false;

  constructor(
    private store: NetworkSettingsStore,
    available = true,
    private probe?: ProxyProbe,
  ) {
    this.snapshot = {
      settings: defaultNetworkSettings,
      ready: false,
      error: "",
      available,
      testing: false,
      testResult: null,
    };
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
  private exclusive<T>(operation: () => Promise<T>) {
    const pending = this.serial.then(operation);
    this.serial = pending.catch(() => {});
    return pending;
  }
  initialize() {
    this.initialized ??= this.exclusive(async () => {
      try {
        if (this.snapshot.available) {
          const saved = await this.store.read();
          if (saved !== null) {
            this.publish({ settings: validateNetworkSettings(saved) });
            this.saved = true;
          }
        }
        this.publish({ ready: true });
      } catch {
        this.publish({ ready: true, error: "无法读取网络设置，请重新保存代理配置。" });
      }
    });
    return this.initialized;
  }
  async update(settings: NetworkSettings) {
    const validated = validateNetworkSettings(settings);
    await this.initialize();
    return this.exclusive(async () => {
      if (!this.snapshot.available) throw new Error("请在桌面端保存网络设置。");
      await this.store.write(validated);
      this.saved = true;
      this.publish({ settings: validated, error: "" });
    });
  }
  async importLegacyProxy(proxy: string) {
    await this.initialize();
    return this.exclusive(async () => {
      // A saved global choice, including disabling the proxy, always wins.
      if (this.saved || !proxy || !this.snapshot.available || this.snapshot.error) return;
      try {
        const settings = validateNetworkSettings({ proxyEnabled: true, proxy });
        await this.store.write(settings);
        this.saved = true;
        this.publish({ settings });
      } catch {
        this.publish({ error: "旧下载代理未能迁移，请在此重新保存代理配置。" });
      }
    });
  }
  getProxy = async () => {
    await this.initialize();
    if (this.snapshot.error) throw new Error(this.snapshot.error);
    const { proxyEnabled, proxy } = this.snapshot.settings;
    return proxyEnabled ? proxy : "";
  };
  clearTestResult = () => this.publish({ testResult: null });
  async testProxy(value: string) {
    if (!this.snapshot.available || !this.probe) throw new Error("请在桌面端测试代理。");
    if (this.stopped) throw new Error("应用正在退出。");
    if (this.activeTest) throw new Error("正在测试代理，请等待或取消当前测试。");
    if (this.stopPending) throw new Error("未能确认代理测试已停止，请退出应用后重试。");
    const { proxy } = validateNetworkSettings({ proxyEnabled: true, proxy: value });
    const abort = new AbortController();
    this.publish({ testing: true, testResult: null });
    const done = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return this.probe!(proxy, abort.signal);
    });
    this.activeTest = { abort, done };
    try {
      const result = await done;
      abort.signal.throwIfAborted();
      this.publish({
        testResult: {
          proxy,
          status: "success",
          message: `已通过代理连接测试站点（www.gstatic.com），耗时 ${result.elapsedMs} ms。`,
        },
      });
    } catch (error) {
      if (error instanceof StopUnconfirmedError) this.stopPending = error.retry;
      const cancelled = abort.signal.aborted && !this.stopPending;
      this.publish({
        testResult: {
          proxy,
          status: cancelled ? "cancelled" : "failed",
          message: this.stopPending
            ? "未能确认代理测试已停止，请退出应用后重试。"
            : cancelled
              ? "已取消代理测试。"
              : error instanceof Error
                ? error.message
                : "代理测试失败，请检查地址和代理服务状态。",
        },
      });
    } finally {
      this.activeTest = undefined;
      this.publish({ testing: false });
    }
  }
  cancelTest = () => this.activeTest?.abort.abort();
  async shutdown() {
    this.stopped = true;
    this.cancelTest();
    await this.activeTest?.done.catch(() => {});
    await this.stopPending?.();
    this.stopPending = undefined;
  }
}
