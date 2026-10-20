import type { ActorDirectoryDimension, DiscoveryData } from "./discoveryData";
import { gfriendsImageBases, validPortraitUrl } from "./portraitUrls";
import { hasControlCharacters } from "./catalogCsv";

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
// JavBus 名单不保存头像地址；先返回空候选供本地缓存命中，缺失时再按名称和别名查 GFriends。
export async function resolvePortraits(
  request: {
    names: string[];
    dimension: ActorDirectoryDimension;
    fallback?: boolean;
  },
  current?: DiscoveryData,
): Promise<Record<string, string[]>> {
  if (request.names.length > 50) throw new Error("头像查询数量超过限制。");
  if (import.meta.env.DEV) return {};
  const records = new Map<string, { ids: Map<string, Set<string>>; aliases: Set<string> }>();
  for (const entry of current?.javbusEntries ?? []) {
    if (entry.dimension !== request.dimension) continue;
    const record = records.get(entry.name) ?? { ids: new Map(), aliases: new Set() };
    record.ids.set(entry.lane, (record.ids.get(entry.lane) ?? new Set()).add(entry.id));
    for (const alias of [entry.name, entry.label, ...entry.aliases]) record.aliases.add(alias);
    records.set(entry.name, record);
  }
  const known = new Set(current?.catalogs[request.dimension].names ?? []);
  const result: Record<string, string[]> = Object.create(null);
  for (const name of request.names) {
    const record = records.get(name);
    // 有码、无码分区各自编号；同一分区内同名不同编号无法确认身份，保留占位图。
    const ambiguous = record && [...record.ids.values()].some((ids) => ids.size > 1);
    if (ambiguous || (!record && !known.has(name))) continue;
    if (!request.fallback) {
      result[name] = [];
      continue;
    }
    for (const alias of record?.aliases ?? [name]) {
      const urls = friends?.get(normalize(alias));
      if (urls) {
        result[name] = urls;
        break;
      }
    }
  }
  return result;
}
