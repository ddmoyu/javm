import {
  UpdateService,
  UpdateRestartRequiredError,
  type UpdatePreferences,
} from "../../services/settings/UpdateService";
import { updateReleases } from "../../services/settings/updateDiscovery";
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
  const getJson = async (url: string, signal: AbortSignal): Promise<unknown> => {
    // Release 附件经 GitHub CDN 跳转；每次都校验 HTTPS，正文有上限。
    for (let hop = 0; hop < 6; hop++) {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || target.port)
        throw new Error("更新请求地址无效。");
      const response = await createResolutionHttp()(
        {
          url,
          headers: { Accept: "application/vnd.github+json" },
          maxBytes: 1024 * 1024,
          timeoutMs: 15000,
          proxy: await network.getProxy(),
        },
        signal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        url = new URL(response.headers.location, url).href;
        continue;
      }
      if (response.status === 403 || response.status === 429)
        throw new Error("官方更新服务暂时限流，请稍后重试。");
      if (response.status !== 200) throw new Error(`更新检查失败（HTTP ${response.status}）。`);
      return JSON.parse(new TextDecoder().decode(response.body));
    }
    throw new Error("更新请求重定向过多。");
  };
  const envelope = (version: string, signal: AbortSignal) =>
    getJson(
      `https://github.com/ddmoyu/javm/releases/download/v${version}/JAVM-update.json`,
      signal,
    ) as Promise<SignedUpdateManifest>;
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
        const releases: unknown[] = [];
        for (let page = 1; page <= 20; page++) {
          const items = await getJson(
            `https://api.github.com/repos/ddmoyu/javm/releases?per_page=30&page=${page}`,
            signal,
          );
          if (!Array.isArray(items)) throw new Error("官方发布列表格式无效。");
          releases.push(...items);
          if (items.length < 30) break;
          if (page === 20) throw new Error("发布记录过多，请前往官方发布页面检查更新。");
        }
        for (const release of updateReleases(releases, packageInfo.version, channel)) {
          const signed = await envelope(release.version, signal);
          const asset = await updateRpc.request<UpdateAsset | null>("update.verify", {
            envelope: signed,
            version: release.version,
            channel,
          });
          if (asset) return { ...release, envelope: signed, asset };
        }
        return null;
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
