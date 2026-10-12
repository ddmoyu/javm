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
import { catalogEntries, queryCatalog } from "./catalogData";
import type { GenreEntry } from "./catalogData";
import type { CatalogRequest } from "./workerClient";
import type { DiscoveryData } from "./discoveryData";
import { collected_at as collectedAt } from "../../../../data/catalogs/avwikidb/manifest.json";
import { loadAvwikiSeed } from "./avwikiSeed";
import { loadJavbusSeed } from "./javbusSeed";
import { loadGfriendsIndex, resolveAvwikiPortraits } from "./avwikiPortraits";
import { parseAvwikiWorkDetails, parseAvwikiWorks, resolveAvwikiEntities } from "./avwikiWorks";
import { isAvwikiDimension } from "./avwikiCsv";
import {
  javbusKinds,
  parseJavbusActresses,
  parseJavbusRelations,
  parseJavbusCsv,
  serializeJavbusCsv,
  resolveJavbusCatalogEntities,
} from "./javbusCatalog";
import type { JavbusCatalogDimension } from "./javbusCatalog";
import {
  planJavbusLookup,
  parseJavbusActors,
  parseJavbusActorSearch,
  parseJavbusFacets,
  parseJavbusWorks,
  parseJavbusWorkDetails,
} from "./javbusWorks";

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
    if (operation === "query")
      value = queryCatalog(payload.names, payload.query, payload.page, payload.videoCounts);
    else if (operation === "javbusActorSearch") value = parseJavbusActorSearch(payload.html,payload.url,payload.page);
    else if (operation === "javbusImportCsv") {
      const files = Object.entries(payload.files) as [JavbusCatalogDimension, string][];
      if (
        files.some(
          ([dimension, csv]) => !Object.hasOwn(javbusKinds, dimension) || typeof csv !== "string",
        ) ||
        files.reduce((size, [, csv]) => size + csv.length, 0) > 16 * 1024 * 1024
      )
        throw new Error("JavBus CSV 总量超过限制。");
      value = files.flatMap(([dimension, csv]) => parseJavbusCsv(csv, dimension, Date.now()));
      if (value.length > 100_000) throw new Error("JavBus CSV 名单超过限制。");
    } else if (operation === "javbusExportCsv")
      value = serializeJavbusCsv(
        (current?.javbusEntries ?? []).filter((entry) => entry.dimension === payload.dimension),
        Date.now(),
      );
    else if (operation === "javbusActresses")
      value = parseJavbusActresses(payload.html, payload.lane, payload.page, Date.now());
    else if (operation === "javbusRelations")
      value = parseJavbusRelations(payload.html, Date.now());
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
    else if (operation === "javbusPlan") {
      value = planJavbusLookup(
        payload.dimension,
        payload.name,
        isAvwikiDimension(payload.dimension) ? (await loadAvwikiSeed())[payload.dimension] : [],
        payload.dimension === "genres"
          ? catalogEntries(
              import.meta.env.DEV ? [] : entries,
              current?.genreCache ?? null,
              Date.now(),
            )
          : [],
        isAvwikiDimension(payload.dimension) ? current?.directoryEntries?.[payload.dimension] : {},
      );
      const entities = new Map(value.entities.map((entity) => [entity.url, entity]));
      for (const entity of resolveJavbusCatalogEntities(
        current?.javbusEntries ?? [],
        payload.dimension,
        value.names,
      ))
        entities.set(entity.url, entity);
      if (entities.size > 50) throw new Error("JavBus 同名来源过多，请确认名称。");
      value.entities = [...entities.values()];
    } else if (operation === "javbusActors") value = parseJavbusActors(payload.html, payload.names);
    else if (operation === "javbusFacets")
      value = parseJavbusFacets(payload.html, payload.dimension, payload.names);
    else if (operation === "javbusWorks")
      value = parseJavbusWorks(payload.html, payload.url, payload.page);
    else if (operation === "javbusDetails")
      value = parseJavbusWorkDetails(payload.html, payload.work);
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
        javbusEntries: await loadJavbusSeed(),
      };
      value =
        operation === "discoveryLoad"
          ? loadDiscovery(builtin, payload.cache, Date.now())
          : mergeDiscovery(builtin, payload.cache, payload.update, Date.now());
      current = value;
      // 实体身份留在 Worker；页面只需目录、计数和增量缓存，避免复制数万条对象。
      value = { ...value, javbusEntries: undefined };
    }
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "名单处理失败。" });
  }
}
