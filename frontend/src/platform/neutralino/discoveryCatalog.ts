import { storage } from "@neutralinojs/lib";
import { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import { CatalogWorkerClient } from "../../services/catalog/workerClient";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { Runtime } from "./bootstrap";
import { PortraitService } from "../../services/catalog/PortraitService";
import { createPortraitPort } from "./portraits";
import { createCatalogHttp } from "./catalogHttp";
import { fetchCatalogWithWebview } from "./catalogWebview";

const CACHE_KEY = "javm-discovery-catalog-v5";
export function createDiscoveryCatalogService(
  runtime: Runtime,
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
) {
  const processor = new CatalogWorkerClient();
  const service = new DiscoveryCatalogService(
    processor,
    runtime === "desktop" && import.meta.env.PROD
      ? {
          async read() {
            try {
              const keys = await storage.getKeys();
              const key = keys.includes(CACHE_KEY)
                ? CACHE_KEY
                : keys.includes("javm-discovery-catalog-v4")
                  ? "javm-discovery-catalog-v4"
                  : keys.includes("javm-discovery-catalog-v3")
                    ? "javm-discovery-catalog-v3"
                    : keys.includes("javm-discovery-catalog-v2")
                      ? "javm-discovery-catalog-v2"
                      : "javm-genre-catalog-v1";
              return keys.includes(key) ? await storage.getData(key) : null;
            } catch (error) {
              if ((error as { code?: string }).code === "NE_ST_NOSTDIR") return null;
              throw new Error("名单缓存读取失败，继续使用内置名单。");
            }
          },
          async write(cache: string) {
            await storage.setData(CACHE_KEY, cache);
          },
          fetch: createCatalogHttp(network, beforeFetch, fetchCatalogWithWebview),
        }
      : undefined,
    runtime === "desktop" && import.meta.env.PROD
      ? new PortraitService(processor, createPortraitPort(network, beforeFetch))
      : undefined,
  );
  void service.initialize();
  return service;
}
