import {
  ApplicationUpdateService,
  releasePlatform,
} from "../../services/settings/ApplicationUpdateService";
import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { createResolutionHttp } from "./resolutionHttp";
import packageInfo from "../../../../package.json";
let updater: ApplicationUpdateService | undefined;
export function createApplicationUpdater(runtime: Runtime, network: NetworkSettingsService) {
  const platform =
    runtime === "desktop"
      ? releasePlatform(window.NL_OS, (window as unknown as { NL_ARCH: string }).NL_ARCH)
      : undefined;
  return (updater ??= new ApplicationUpdateService(
    packageInfo.version,
    async (signal) => {
      const response = await createResolutionHttp()(
        {
          url: "https://api.github.com/repos/ddmoyu/javm/releases/latest",
          headers: { Accept: "application/vnd.github+json" },
          maxBytes: 256 * 1024,
          timeoutMs: 15000,
          proxy: await network.getProxy(),
        },
        signal,
      );
      if (response.status === 404) throw new Error("官方尚未提供可检查的正式发布。");
      if (response.status !== 200) throw new Error(`更新检查失败（HTTP ${response.status}）。`);
      return JSON.parse(new TextDecoder().decode(response.body));
    },
    !!platform,
    platform,
  ));
}
