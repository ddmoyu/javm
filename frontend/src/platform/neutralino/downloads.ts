import { DownloadService } from "../../services/downloads/DownloadService";
import { ToolDownloadEngine } from "../../services/downloads/ToolDownloadEngine";
import { NativeDownloadRepository } from "./downloadRepository";
import { nativeDownloadHost } from "./downloadHost";
import { desktopServicesAvailable } from "./desktopCapabilities";
import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";

export function createDownloadService(runtime: Runtime, network: NetworkSettingsService) {
  const service = new DownloadService(
    new NativeDownloadRepository((proxy) => network.importLegacyProxy(proxy)),
    new ToolDownloadEngine(nativeDownloadHost, network.getProxy),
    desktopServicesAvailable(runtime),
  );
  void service.initialize();
  return service;
}
