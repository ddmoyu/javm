import { AiService } from "../../services/metadata/AiService";
import { MetaTubeService } from "../../services/metadata/MetaTubeService";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { Runtime } from "./bootstrap";
import { createMetadataHttp, protectedSettingsStore } from "./metadataHttp";
import { createMetaTubeHost } from "./metatubeHost";

export function createMetadataServices(
  runtime: Runtime,
  network: NetworkSettingsService,
  prepare?: () => Promise<void>,
) {
  const available =
    runtime === "desktop" && (window as unknown as { NL_OS: string }).NL_OS === "Windows";
  const http = createMetadataHttp(network);
  const ai = new AiService(protectedSettingsStore("javm-ai-settings-v1"), http, available);
  const metatube = new MetaTubeService(
    protectedSettingsStore("javm-metatube-settings-v1"),
    http,
    createMetaTubeHost(network),
    available,
    prepare,
  );
  void ai.settings.initialize();
  void metatube.initialize();
  return { ai, metatube };
}
