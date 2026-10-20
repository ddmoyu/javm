import { Observable, type Store } from "../metadata/shared";
import type {
  NativeUpdateStatus,
  UpdateCandidate,
  UpdateChannel,
  UpdateInstallation,
} from "../../contracts/updates";
import { defaultUpdateChannel } from "./updateVersions";
import { isUpdateMirror, normalizeUpdateMirror, type UpdateMirror } from "./updateSources";
import { UpdateCheckDeferredError } from "./updateHttp";

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
  mirror?: UpdateMirror;
  customMirror?: string;
}
const interval = 24 * 60 * 60 * 1000;
export class UpdateRestartRequiredError extends Error {}
export class UpdateService extends Observable<{
  available: boolean;
  initialized: boolean;
  channel: UpdateChannel;
  automatic: boolean;
  mirror: UpdateMirror;
  customMirror: string;
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
      mirror: "auto",
      customMirror: "",
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
    this.preferences = { channel, automatic: true, lastCheck: 0, mirror: "auto", customMirror: "" };
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
            typeof saved.automatic !== "boolean" ||
            (saved.mirror !== undefined && !isUpdateMirror(saved.mirror)) ||
            (saved.customMirror !== undefined && typeof saved.customMirror !== "string")
          )
            throw new Error("更新设置格式无效，原配置已保留，请检查数据目录后重新打开应用。");
          this.preferences = {
            channel: saved.channel,
            automatic: saved.automatic,
            mirror: saved.mirror ?? "auto",
            customMirror:
              saved.customMirror || saved.mirror === "custom"
                ? normalizeUpdateMirror(saved.customMirror ?? "")
                : "",
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
          mirror: this.preferences.mirror ?? "auto",
          customMirror: this.preferences.customMirror ?? "",
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
  async configure(
    channel: UpdateChannel,
    automatic: boolean,
    mirror: UpdateMirror = this.snapshot.mirror,
    customMirror = this.snapshot.customMirror,
  ) {
    await this.initialize();
    if (this.snapshot.restartRequired) throw new Error("请重新打开应用后继续更新。");
    if (
      this.snapshot.configuring ||
      this.controller ||
      ["waiting", "installing"].includes(this.snapshot.status.phase)
    )
      throw new Error("请先取消当前更新操作。");
    if (channel !== "stable" && channel !== "beta") throw new Error("更新通道无效。");
    if (!isUpdateMirror(mirror)) throw new Error("更新镜像选项无效。");
    customMirror = customMirror || mirror === "custom" ? normalizeUpdateMirror(customMirror) : "";
    const changed =
      channel !== this.snapshot.channel ||
      mirror !== this.snapshot.mirror ||
      customMirror !== this.snapshot.customMirror;
    this.publish({ configuring: true });
    try {
      if (changed && this.snapshot.status.phase === "ready") await this.port.cancel();
      const next = {
        channel,
        automatic,
        mirror,
        customMirror,
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
              mirror,
              customMirror,
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
        let release = await this.port.find(this.preferences.channel, controller.signal);
        controller.signal.throwIfAborted();
        if (!manual && release?.version === this.failedVersion) release = null;
        this.publish({ release, checked: true });
      } catch (error) {
        if (!controller.signal.aborted)
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
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "更新操作失败。";
}
