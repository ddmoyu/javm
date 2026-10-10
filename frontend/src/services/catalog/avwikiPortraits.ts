import portraitsUrl from "../../../../data/catalogs/avwikidb/portraits.json?url";
import { loadAvwikiSeed } from "./avwikiSeed";
import type { ActorDirectoryDimension, DiscoveryData } from "./discoveryData";
import { gfriendsImageBases, validPortraitUrl } from "./portraitUrls";
import { hasControlCharacters } from "./avwikiCsv";

type PortraitIndex = Record<ActorDirectoryDimension, Record<string, string>>;
let builtin: Promise<PortraitIndex> | undefined;
let friends: Map<string, string[]> | undefined;
const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
export function loadGfriendsIndex(json: string) {
  if (json.length > 16 * 1024 * 1024) throw new Error("备用头像索引过大。");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("备用头像索引无效。");
  }
  if (!value || !value.Content || typeof value.Content !== "object" || Array.isArray(value.Content))
    throw new Error("备用头像索引无效。");
  const index = new Map<string, string[]>();
  let count = 0;
  for (const [folder, files] of Object.entries(value.Content)) {
    if (
      !folder ||
      folder.includes("/") ||
      folder.includes("\\") ||
      hasControlCharacters(folder) ||
      folder === ".." ||
      !files ||
      typeof files !== "object" ||
      Array.isArray(files)
    )
      continue;
    for (const [filename, target] of Object.entries(files)) {
      if (++count > 200_000) throw new Error("备用头像索引超过条目限制。");
      if (
        typeof target !== "string" ||
        !filename.endsWith(".jpg") ||
        filename.includes("/") ||
        filename.includes("\\") ||
        hasControlCharacters(filename)
      )
        continue;
      const path = /^([^/?#\\]+\.jpg)(\?t=\d+(?:\.\d+)?)?$/.exec(target);
      if (!path || path[1] === "..") continue;
      const suffix = `${encodeURIComponent(folder)}/${encodeURIComponent(path[1]!)}${path[2] ?? ""}`;
      const urls = gfriendsImageBases.map((base) => `${base}${suffix}`);
      if (urls.every(validPortraitUrl)) index.set(normalize(filename.slice(0, -4)), urls);
    }
  }
  if (!index.size) throw new Error("备用头像索引没有有效条目。");
  // 文件树按质量升序排列，后出现的同名图片优先。
  friends = index;
}
export async function resolveAvwikiPortraits(
  request: {
    names: string[];
    dimension: ActorDirectoryDimension;
    fallback?: boolean;
  },
  current?: DiscoveryData,
): Promise<Record<string, string[]>> {
  if (request.names.length > 50) throw new Error("头像查询数量超过限制。");
  if (import.meta.env.DEV) return {};
  const seed = await loadAvwikiSeed();
  const records = new Map<string, typeof seed.actresses>();
  for (const entry of seed[request.dimension]) {
    const list = records.get(entry.name) ?? [];
    list.push(entry);
    records.set(entry.name, list);
  }
  if (!request.fallback)
    builtin ??= (async () => {
      const response = await fetch(portraitsUrl);
      if (!response.ok) throw new Error("内置头像索引读取失败。");
      const value = await response.json();
      return value.portraits as PortraitIndex;
    })();
  const images = request.fallback ? undefined : await builtin;
  const result: Record<string, string[]> = Object.create(null);
  const known = new Set(current?.catalogs[request.dimension].names ?? []);
  for (const name of request.names) {
    const entries = records.get(name);
    // 同名不同编号无法确认身份，保留占位图。
    if ((entries && entries.length !== 1) || (!entries && !known.has(name))) continue;
    const entry = entries?.[0] ?? { id: "", name, label: name, aliases: [] };
    if (!request.fallback) {
      result[name] = [];
      const url =
        current?.directoryPortraits[request.dimension]?.[name] ??
        images?.[request.dimension]?.[entry.id];
      if (typeof url === "string" && validPortraitUrl(url)) result[name] = [url];
    } else {
      for (const alias of [entry.name, entry.label, ...entry.aliases]) {
        const urls = friends?.get(normalize(alias));
        if (urls) {
          result[name] = urls;
          break;
        }
      }
    }
  }
  return result;
}
