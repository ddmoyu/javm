import { filesystem, storage } from "@neutralinojs/lib";
import { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { Runtime } from "./bootstrap";
import { testProxyConnection } from "./proxyTest";

const key = "javm-network-v1";

export function createNetworkSettings(runtime: Runtime) {
  const service = new NetworkSettingsService(
    {
      async read() {
        let keys: string[];
        try {
          keys = await storage.getKeys();
        } catch (error) {
          // On first launch Neutralino has not created its storage directory yet.
          if ((error as { code?: string }).code === "NE_ST_NOSTDIR") {
            try {
              await filesystem.getStats(`${window.NL_DATAPATH}/.storage`);
            } catch (statError) {
              if ((statError as { code?: string }).code === "NE_FS_NOPATHE") return null;
            }
          }
          throw error;
        }
        if (!keys.includes(key)) return null;
        return JSON.parse(await storage.getData(key)) as unknown;
      },
      write: (settings) => storage.setData(key, JSON.stringify(settings)),
    },
    runtime === "desktop",
    testProxyConnection,
  );
  void service.initialize();
  return service;
}
