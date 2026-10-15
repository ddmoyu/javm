import { os } from "@neutralinojs/lib";
import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { MagnetSearchService } from "../../services/magnets/MagnetSearchService";
import { magnetLimits, magnetSearchUrl } from "../../services/magnets/types";
import { ResolutionHttpSession } from "../../services/streamResolution/http";
import { ResolutionWorkerPool } from "../../services/streamResolution/workerClient";
import { createResolutionHttp } from "./resolutionHttp";
import { desktopServicesAvailable } from "./desktopCapabilities";

export function createMagnetSearch(
  runtime: Runtime,
  network: NetworkSettingsService,
  prepare: () => Promise<void>,
) {
  if (!desktopServicesAvailable(runtime)) return new MagnetSearchService();
  const parser = new ResolutionWorkerPool();
  const http = createResolutionHttp();
  return new MagnetSearchService({
    merge: (existing, incoming, signal) =>
      parser.run("magnetMerge", { body: new ArrayBuffer(0), existing, incoming }, signal),
    async search(source, query, page, signal) {
      const deadline = Date.now() + magnetLimits.sourceMs;
      await prepare();
      signal.throwIfAborted();
      const proxy = await network.getProxy();
      signal.throwIfAborted();
      const url = magnetSearchUrl(source, query, page);
      const session = new ResolutionHttpSession(
        {
          url,
          provider: "static-page",
          preferProxy: !!proxy,
          headers: { Accept: "text/html,application/xhtml+xml" },
        },
        http,
        proxy,
        deadline,
        signal,
        () => {},
      );
      const response = await session.get(url, magnetLimits.bytes);
      signal.throwIfAborted();
      return parser.run("magnet", { body: response.body, url: response.url, source }, signal);
    },
    open: (url) => os.open(url),
    close: () => parser.close(),
  });
}
