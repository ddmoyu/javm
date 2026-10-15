import { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { NetworkSettings } from "../../contracts/network";
import type { Runtime } from "./bootstrap";
import { testProxyConnection } from "./proxyTest";
import { nativeSettingsStorage } from "./settingsStorage";

const key = "javm-network-v1";

export function createNetworkSettings(runtime: Runtime) {
  const service = new NetworkSettingsService(
    nativeSettingsStorage<NetworkSettings>(key),
    runtime === "desktop",
    testProxyConnection,
  );
  void service.initialize();
  return service;
}
