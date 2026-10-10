import { DownloadService } from "../../services/downloads/DownloadService";
import { ToolDownloadEngine } from "../../services/downloads/ToolDownloadEngine";
import { NativeDownloadRepository } from "./downloadRepository";
import { nativeDownloadHost } from "./downloadHost";
import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";

export function createDownloadService(runtime: Runtime, network: NetworkSettingsService) {
  const windows =
    runtime === "desktop" && (window as unknown as { NL_OS: string }).NL_OS === "Windows";
  const service = new DownloadService(
    new NativeDownloadRepository((proxy) => network.importLegacyProxy(proxy)),
    new ToolDownloadEngine(nativeDownloadHost, network.getProxy),
    windows,
  );
  void service.initialize();
  return service;
}
