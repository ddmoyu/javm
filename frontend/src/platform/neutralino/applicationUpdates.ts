import {
  UpdateService,
  UpdateRestartRequiredError,
  type UpdatePreferences,
} from "../../services/settings/UpdateService";
import {
  acceptsVersion,
  compareVersions,
  parseVersion,
} from "../../services/settings/updateVersions";
import {
  UpdateHttp,
  UpdateCheckDeferredError,
  updateRequestMs,
  type UpdateHttpState,
} from "../../services/settings/updateHttp";
import { updateSources } from "../../services/settings/updateSources";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { logEvent } from "../../services/logging/events";
import type {
  NativeUpdateStatus,
  SignedUpdateManifest,
  UpdateAsset,
  UpdateInstallation,
} from "../../contracts/updates";
import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { createResolutionHttp } from "./resolutionHttp";
import { nativeSettingsStorage } from "./settingsStorage";
import {
  cancelUpdateHandoff,
  configureUpdater,
  markUpdateExitReady,
  updateRpc,
} from "./updateStartup";
import { exitApplication } from "./lifecycle";
import packageInfo from "../../../../package.json";

let updater: UpdateService | undefined;
export function createApplicationUpdater(runtime: Runtime, network: NetworkSettingsService) {
  if (updater) return updater;
  const desktop = runtime === "desktop";
  let installation: UpdateInstallation;
  const transport = createResolutionHttp(updateRequestMs);
  const http = new UpdateHttp(
    async (request, signal) => transport({ ...request, proxy: await network.getProxy() }, signal),
    desktop
      ? nativeSettingsStorage<UpdateHttpState>("application-update-cache-v1")
      : { read: async () => null, write: async () => {} },
  );
  const sources = () =>
    updateSources(updater!.getSnapshot().mirror, updater!.getSnapshot().customMirror);
  const fromSources = async <T>(
    url: string,
    signal: AbortSignal,
    accept: (value: unknown) => Promise<T>,
  ): Promise<T> => {
    let failure: unknown;
    let deferred: UpdateCheckDeferredError | undefined;
    for (const prefix of sources()) {
      signal.throwIfAborted();
      const target = prefix + url;
      try {
        const value = await http.json(target, signal);
        try {
          const result = await accept(value);
          logEvent(
            "debug",
            "update",
            "source_verified",
            "更新来源响应已验证",
            {},
            { requestUrl: target },
          );
          return result;
        } catch (error) {
          await http.discard(target);
          throw error;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof StopUnconfirmedError) throw error;
        logEvent(
          "warn",
          "update",
          "source_failed",
          "更新来源不可用",
          { error: error instanceof Error ? error.message : "未知错误" },
          { requestUrl: target },
        );
        failure = error;
        if (
          error instanceof UpdateCheckDeferredError &&
          (!deferred || error.retryAt < deferred.retryAt)
        )
          deferred = error;
      }
    }
    throw deferred ?? failure;
  };
  const verified = async (value: unknown, channel: "stable" | "beta", expected?: string) => {
    const signed = value as SignedUpdateManifest;
    if (!signed || typeof signed.payload !== "string" || typeof signed.signature !== "string")
      throw new Error("更新清单格式无效。");
    const { version } = JSON.parse(signed.payload) as { version?: unknown };
    if (
      typeof version !== "string" ||
      version.startsWith("v") ||
      !parseVersion(version) ||
      !acceptsVersion(version, channel) ||
      (expected && expected !== version)
    )
      throw new Error("更新版本或通道不匹配。");
    // 包括缓存及当前版本清单，都必须先经原生验签，才可判断是否有更新。
    const asset = await updateRpc.request<UpdateAsset | null>("update.verify", {
      envelope: signed,
      version,
      channel,
    });
    return { envelope: signed, version, asset };
  };
  const envelope = (version: string, signal: AbortSignal) =>
    fromSources(
      `https://github.com/ddmoyu/javm/releases/download/v${version}/JAVM-update.json`,
      signal,
      // 从 Beta 切换正式版时，当前安装的 Beta 回退包仍然有效。
      async (value) => (await verified(value, "beta", version)).envelope,
    );
  const status = () => updateRpc.request<NativeUpdateStatus>("update.status");
  updater = new UpdateService(
    packageInfo.version,
    {
      async installation() {
        return (installation = desktop
          ? await configureUpdater()
          : { available: false, reason: "请在桌面安装版中检查更新。" });
      },
      async find(channel, signal) {
        const result = await fromSources(
          channel === "stable"
            ? "https://github.com/ddmoyu/javm/releases/latest/download/JAVM-update.json"
            : "https://github.com/ddmoyu/javm/releases/download/updates-beta/JAVM-update.json",
          signal,
          (value) => verified(value, channel),
        );
        if (!result.asset || compareVersions(result.version, packageInfo.version) <= 0) return null;
        return {
          ...result,
          asset: result.asset,
          url: `https://github.com/ddmoyu/javm/releases/tag/v${result.version}`,
          notes: "",
        };
      },
      async download(candidate, signal, progress) {
        const rollback =
          installation.kind === "setup" || installation.kind === "deb"
            ? await envelope(packageInfo.version, signal)
            : null;
        signal.throwIfAborted();
        await updateRpc.request("update.download", {
          envelope: candidate.envelope,
          rollback,
          channel: updater!.getSnapshot().channel,
          proxy: await network.getProxy(),
          sources: sources(),
        });
        let cancelled = false;
        for (;;) {
          if (signal.aborted && !cancelled) {
            cancelled = true;
            await updateRpc.request("update.cancel");
          }
          const value = await status();
          progress(value);
          if (value.phase === "ready") {
            signal.throwIfAborted();
            return;
          }
          if (value.phase === "failed" || value.phase === "cancelled")
            throw new Error(value.error || "更新下载已取消。");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      },
      status,
      async install() {
        const { readyFile } = await updateRpc.request<{ readyFile: string }>("update.handoff");
        try {
          await exitApplication(() => markUpdateExitReady(readyFile));
        } catch (error) {
          await cancelUpdateHandoff(readyFile).catch(() => {});
          throw new UpdateRestartRequiredError(
            `退出未完成，更新未安装。请重新打开应用后继续安装。${error instanceof Error ? error.message : ""}`,
          );
        }
      },
      async cancel() {
        if (desktop && installation?.kind) await updateRpc.request("update.cancel");
      },
    },
    desktop
      ? nativeSettingsStorage<UpdatePreferences>("application-update-v1")
      : { read: async () => null, write: async () => {} },
  );
  void updater.initialize();
  return updater;
}
