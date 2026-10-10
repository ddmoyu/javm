import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { ResolutionService } from "../../services/streamResolution/ResolutionService";
import { ResolutionWorkerPool } from "../../services/streamResolution/workerClient";
import { createResolutionHttp } from "./resolutionHttp";
import { createHiddenWebview } from "./hiddenWebview";

export function createResolutionService(
  runtime: Runtime,
  network: NetworkSettingsService,
  prepare: () => Promise<void>,
) {
  const available =
    runtime === "desktop" && (window as unknown as { NL_OS: string }).NL_OS === "Windows";
  return new ResolutionService({
    http: available ? createResolutionHttp() : undefined,
    webview: available ? createHiddenWebview() : undefined,
    parser: new ResolutionWorkerPool(),
    getProxy: network.getProxy,
    prepare,
  });
}
