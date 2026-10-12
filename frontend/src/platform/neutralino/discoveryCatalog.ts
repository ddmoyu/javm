import { filesystem, os, storage } from "@neutralinojs/lib";
import { javbusKinds } from "../../services/catalog/javbusCatalog";
import type { JavbusCatalogDimension } from "../../services/catalog/javbusCatalog";
import { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import { CatalogWorkerClient } from "../../services/catalog/workerClient";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { Runtime } from "./bootstrap";
import { PortraitService } from "../../services/catalog/PortraitService";
import { createPortraitPort } from "./portraits";
import { createCatalogHttp } from "./catalogHttp";
import { NativeLibraryPort } from "./library";
import { createCatalogSeedPort } from "./catalogSeed";

const CACHE_KEY = "javm-discovery-catalog-v8";
export function createDiscoveryCatalogService(
  runtime: Runtime,
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
) {
  const processor = new CatalogWorkerClient();
  let importLegacyCsv = true;
  let csvReady: Promise<string> | undefined;
  const csvDirectory = () =>
    (csvReady ??= (async () => {
      const directory = `${await os.getEnv("LOCALAPPDATA")}/JAVM/catalogs/javbus`;
      if (!/^[A-Z]:[\\/]/i.test(directory)) throw new Error("无法定位目录 CSV 路径。");
      try {
        await filesystem.createDirectory(directory);
      } catch (error) {
        if (!(await filesystem.getStats(directory).catch(() => null))?.isDirectory) throw error;
      }
      return directory;
    })().catch((error) => {
      csvReady = undefined;
      throw error;
    }));
  const service = new DiscoveryCatalogService(
    processor,
    runtime === "desktop" && import.meta.env.PROD
      ? {
          ...createCatalogSeedPort(new NativeLibraryPort()),
          async read() {
            try {
              const keys = await storage.getKeys();
              importLegacyCsv = !keys.includes(CACHE_KEY);
              const key = keys.includes(CACHE_KEY)
                ? CACHE_KEY
                : keys.includes("javm-discovery-catalog-v6")
                  ? "javm-discovery-catalog-v6"
                  : keys.includes("javm-discovery-catalog-v5")
                    ? "javm-discovery-catalog-v5"
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
          async readCsv() {
            if (!importLegacyCsv) return {};
            const directory = await csvDirectory(),
              files: Partial<Record<JavbusCatalogDimension, string>> = {};
            let bytes = 0;
            for (const dimension of Object.keys(javbusKinds) as JavbusCatalogDimension[]) {
              const path = `${directory}/${dimension}.csv`,
                stat = await filesystem.getStats(path).catch(() => null);
              if (!stat) continue;
              bytes += stat.size;
              if (!stat.isFile || bytes > 16 * 1024 * 1024)
                throw new Error("目录 CSV 超过大小限制。");
              files[dimension] = await filesystem.readFile(path);
            }
            return files;
          },
          fetch: createCatalogHttp(network, beforeFetch),
        }
      : undefined,
    runtime === "desktop" && import.meta.env.PROD
      ? new PortraitService(processor, createPortraitPort(network, beforeFetch))
      : undefined,
  );
  void service.initialize();
  return service;
}
