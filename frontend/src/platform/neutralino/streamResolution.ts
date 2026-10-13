import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { ResolutionService } from "../../services/streamResolution/ResolutionService";
import { ResolutionWorkerPool } from "../../services/streamResolution/workerClient";
import { createResolutionHttp } from "./resolutionHttp";
import { createHiddenWebview } from "./hiddenWebview";
import { desktopServicesAvailable } from "./desktopCapabilities";

export function createResolutionService(
  runtime: Runtime,
  network: NetworkSettingsService,
  prepare: () => Promise<void>,
) {
  const available = desktopServicesAvailable(runtime);
  return new ResolutionService({
    http: available ? createResolutionHttp() : undefined,
    webview: available && window.NL_OS === "Windows" ? createHiddenWebview() : undefined,
    parser: new ResolutionWorkerPool(),
    getProxy: network.getProxy,
    prepare,
  });
}
