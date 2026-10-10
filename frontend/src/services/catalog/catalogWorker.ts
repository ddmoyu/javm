import seed from "./builtin-genres.json";
import entities from "./builtin-entities.json";
import {
  loadDiscovery,
  mergeDiscovery,
  parseActorDirectory,
  parseAvwikiDirectory,
  parseEntities,
  parseListing,
} from "./discoveryData";
import { queryCatalog } from "./catalogData";
import type { GenreEntry } from "./catalogData";
import type { CatalogRequest } from "./workerClient";
import type { DiscoveryData } from "./discoveryData";
import { collected_at as collectedAt } from "../../../../data/catalogs/avwikidb/manifest.json";
import { loadAvwikiSeed } from "./avwikiSeed";
import { loadGfriendsIndex, resolveAvwikiPortraits } from "./avwikiPortraits";
import { parseAvwikiWorkDetails, parseAvwikiWorks, resolveAvwikiEntities } from "./avwikiWorks";

// 请求顺序有界，由客户端限制为八个；避免异步初始化交错覆盖状态。
let queue = Promise.resolve();
let current: DiscoveryData | undefined;
self.onmessage = (event: MessageEvent<CatalogRequest>) => {
  queue = queue.then(() => process(event.data));
};
async function process(request: CatalogRequest) {
  const { id, operation, payload } = request;
  try {
    const entries = seed.entries as GenreEntry[];
    let value;
    if (operation === "query") value = queryCatalog(payload.names, payload.query, payload.page);
    else if (operation === "listing") value = parseListing(payload.html, payload.lane);
    else if (operation === "entities") value = parseEntities(payload.html);
    else if (operation === "actorDirectory")
      value = parseActorDirectory(payload.html, payload.dimension, payload.page);
    else if (operation === "directory")
      value = parseAvwikiDirectory(payload.html, payload.dimension, payload.page);
    else if (operation === "workEntities")
      value = resolveAvwikiEntities(
        (await loadAvwikiSeed())[payload.dimension],
        payload.dimension,
        payload.name,
        current?.directoryEntries?.[payload.dimension],
      );
    else if (operation === "works")
      value = parseAvwikiWorks(payload.html, payload.entity, payload.page);
    else if (operation === "workDetails")
      value = parseAvwikiWorkDetails(payload.html, payload.work);
    else if (operation === "portraits") value = await resolveAvwikiPortraits(payload, current);
    else if (operation === "portraitIndex") {
      loadGfriendsIndex(payload.json);
      value = true;
    } else {
      const builtin = {
        genres: import.meta.env.DEV ? [] : entries,
        actors: [],
        entities: import.meta.env.DEV
          ? []
          : entities.entries.filter((entry) => entry.dimension === "labels"),
        avwikiDirectories: await loadAvwikiSeed(),
        avwikiCollectedAt: Date.parse(collectedAt),
      };
      value =
        operation === "discoveryLoad"
          ? loadDiscovery(builtin, payload.cache, Date.now())
          : mergeDiscovery(builtin, payload.cache, payload.update, Date.now());
      current = value;
    }
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "名单处理失败。" });
  }
}
