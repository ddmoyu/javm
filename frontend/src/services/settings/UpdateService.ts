import { Observable, type Store } from "../metadata/shared";
import type {
  NativeUpdateStatus,
  UpdateCandidate,
  UpdateChannel,
  UpdateInstallation,
} from "../../contracts/updates";
import { defaultUpdateChannel } from "./updateVersions";
import { UpdateCheckDeferredError } from "./updateHttp";
import { StopUnconfirmedError } from "../downloads/ports";

export interface UpdatePort {
  installation(): Promise<UpdateInstallation>;
  find(channel: UpdateChannel, signal: AbortSignal): Promise<UpdateCandidate | null>;
  download(
    candidate: UpdateCandidate,
    signal: AbortSignal,
    progress: (status: NativeUpdateStatus) => void,
  ): Promise<void>;
  status(): Promise<NativeUpdateStatus>;
  install(): Promise<void>;
  cancel(): Promise<void>;
}
export interface UpdatePreferences {
  channel: UpdateChannel;
  automatic: boolean;
  lastCheck: number;
}
const interval = 24 * 60 * 60 * 1000;
export class UpdateRestartRequiredError extends Error {}
export class UpdateService extends Observable<{
  available: boolean;
  initialized: boolean;
  channel: UpdateChannel;
  automatic: boolean;
  retryAt: number;
  configuring: boolean;
  checking: boolean;
  checked: boolean;
  release: UpdateCandidate | null;
  status: NativeUpdateStatus;
  error: string;
  reason: string;
  restartRequired: boolean;
}> {
  private loading?: Promise<void>;
  private preferences: UpdatePreferences;
  private controller?: AbortController;
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failedVersion = "";
  private cleanup?: StopUnconfirmedError;
  private cleaning?: Promise<void>;
  constructor(
    readonly current: string,
    private port: UpdatePort,
    private store: Store<UpdatePreferences>,
  ) {
    const channel = defaultUpdateChannel(current);
    super({
      available: false,
      initialized: false,
      channel,
      automatic: true,
      retryAt: 0,
      configuring: false,
      checking: false,
      checked: false,
      release: null,
      status: { phase: "idle" },
      error: "",
      reason: "",
      restartRequired: false,
    });
    this.preferences = { channel, automatic: true, lastCheck: 0 };
  }
  initialize() {
    return (this.loading ??= (async () => {
      try {
        const saved = (await this.store.read()) as Partial<UpdatePreferences> | null;
        if (saved !== null) {
          if (
            !saved ||
            typeof saved !== "object" ||
            Array.isArray(saved) ||
            (saved.channel !== "stable" && saved.channel !== "beta") ||
            typeof saved.automatic !== "boolean"
          )
            throw new Error("更新设置格式无效，原配置已保留，请检查数据目录后重新打开应用。");
          // 旧版 mirror/customMirror 不再参与更新，忽略它们并保留通道、自动检查与检查时间。
          this.preferences = {
            channel: saved.channel,
            automatic: saved.automatic,
            lastCheck: Number.isFinite(saved.lastCheck)
              ? Math.max(0, Math.min(saved.lastCheck!, Date.now()))
              : 0,
          };
        }
        const install = await this.port.installation();
        this.failedVersion = install.failedVersion ?? "";
        this.publish({
          available: install.available,
          reason: install.reason ?? "",
          channel: this.preferences.channel,
          automatic: this.preferences.automatic,
        });
        if (install.available) this.publish({ status: await this.port.status() });
      } catch (error) {
        this.publish({ error: message(error) });
      } finally {
        this.publish({ initialized: true });
        this.schedule();
      }
    })());
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.snapshot.available || !this.preferences.automatic) return;
    const delay = Math.max(10000, this.preferences.lastCheck + interval - Date.now());
    this.timer = setTimeout(() => {
      void this.check(false);
    }, delay);
  }
  async configure(channel: UpdateChannel, automatic: boolean) {
    await this.initialize();
    if (this.snapshot.restartRequired) throw new Error("请重新打开应用后继续更新。");
    if (
      this.snapshot.configuring ||
      this.controller ||
      ["waiting", "installing"].includes(this.snapshot.status.phase)
    )
      throw new Error("请先取消当前更新操作。");
    if (channel !== "stable" && channel !== "beta") throw new Error("更新通道无效。");
    const changed = channel !== this.snapshot.channel;
    this.publish({ configuring: true });
    try {
      if (changed && this.snapshot.status.phase === "ready") await this.port.cancel();
      const next = {
        channel,
        automatic,
        lastCheck: changed ? 0 : this.preferences.lastCheck,
      };
      await this.store.write(next);
      this.preferences = next;
      this.publish(
        !changed
          ? { channel, automatic, error: "" }
          : {
              channel,
              automatic,
              retryAt: 0,
              release: null,
              checked: false,
              status: { phase: "idle" },
              error: "",
            },
      );
    } finally {
      this.publish({ configuring: false });
      this.schedule();
    }
  }
  async check(manual = true) {
    await this.initialize();
    if (
      this.stopped ||
      this.snapshot.configuring ||
      this.snapshot.restartRequired ||
      this.controller ||
      !this.snapshot.available ||
      this.snapshot.status.phase === "ready"
    )
      return;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ checking: true, error: "", retryAt: 0 });
    const work = (async () => {
      try {
        await this.retryCleanup();
        controller.signal.throwIfAborted();
        let release = await this.port.find(this.preferences.channel, controller.signal);
        controller.signal.throwIfAborted();
        if (!manual && release?.version === this.failedVersion) release = null;
        this.publish({ release, checked: true });
      } catch (error) {
        if (error instanceof StopUnconfirmedError) this.cleanup = error;
        if (!controller.signal.aborted || error instanceof StopUnconfirmedError)
          this.publish({
            error: message(error),
            retryAt: error instanceof UpdateCheckDeferredError ? error.retryAt : 0,
          });
      } finally {
        this.preferences = { ...this.preferences, lastCheck: Date.now() };
        try {
          await this.store.write(this.preferences);
        } catch {
          this.publish({ error: "更新检查记录保存失败。" });
        }
        this.controller = undefined;
        this.publish({ checking: false });
        this.schedule();
      }
    })();
    this.work = work;
    await work;
  }
  private retryCleanup(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const pending = this.cleanup;
    if (!pending) return Promise.resolve();
    this.cleaning = pending
      .retry()
      .then(() => {
        if (this.cleanup === pending) this.cleanup = undefined;
      })
      .catch((error: unknown) => {
        if (error instanceof StopUnconfirmedError) this.cleanup = error;
        throw this.cleanup;
      })
      .finally(() => {
        this.cleaning = undefined;
      });
    return this.cleaning;
  }
  async download() {
    const release = this.snapshot.release;
    if (
      !release ||
      this.controller ||
      this.stopped ||
      this.snapshot.configuring ||
      this.snapshot.restartRequired
    )
      return;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({
      error: "",
      status: {
        phase: "downloading",
        version: release.version,
        bytes: 0,
        total: release.asset.bytes,
      },
    });
    const work = this.port
      .download(release, controller.signal, (status) => this.publish({ status }))
      .then(async () => this.publish({ status: await this.port.status() }))
      .catch((error: unknown) =>
        this.publish({
          error: controller.signal.aborted ? "" : message(error),
          status: { phase: controller.signal.aborted ? "cancelled" : "failed" },
        }),
      )
      .finally(() => {
        this.controller = undefined;
      });
    this.work = work;
    await work;
  }
  async cancel() {
    if (
      ["waiting", "backing-up", "installing", "trial", "rolling-back"].includes(
        this.snapshot.status.phase,
      )
    )
      return;
    this.controller?.abort();
    await this.port.cancel();
    await this.work;
    await this.retryCleanup();
    this.publish({ status: { phase: "cancelled" } });
  }
  async install() {
    if (
      this.snapshot.status.phase !== "ready" ||
      this.controller ||
      this.snapshot.configuring ||
      this.snapshot.restartRequired
    )
      return;
    this.publish({ error: "", status: { ...this.snapshot.status, phase: "waiting" } });
    try {
      await this.port.install();
    } catch (error) {
      this.publish({
        error: message(error),
        status: { ...this.snapshot.status, phase: "ready" },
        restartRequired: error instanceof UpdateRestartRequiredError,
      });
    }
  }
  async shutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.work;
    await this.retryCleanup();
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "更新操作失败。";
}
