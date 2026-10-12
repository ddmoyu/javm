import { hasControlCharacters, parseCatalogCsvRows } from "./avwikiCsv";
import type { AvwikiEntry } from "./avwikiCsv";
import type { AvwikiEntity } from "./avwikiWorks";
import { parseGenrePage } from "./catalogData";
import type { GenreEntry, GenreLane } from "./catalogData";
import {
  JAVBUS_ORIGIN,
  JAVBUS_ACTRESSES_PAGE_LIMIT,
  anchors,
  attribute,
  documentSource,
  entityOf,
  hasClass,
  infoBlock,
  plain,
  readJavbusVideoCount,
  sourceUrl,
} from "./javbusWorks";

export const javbusKinds = {
  actresses: "star",
  maleActors: "star",
  directors: "director",
  studios: "studio",
  labels: "label",
  series: "series",
  genres: "genre",
} as const;
export type JavbusCatalogDimension = keyof typeof javbusKinds;
export interface JavbusCatalogEntry {
  dimension: JavbusCatalogDimension;
  lane: GenreLane;
  id: string;
  name: string;
  label: string;
  aliases: string[];
  translationStatus: "pending" | "translated" | "reviewed";
  category: string;
  videoCount?: number;
  countUpdatedAt?: number;
}
export const javbusCsvColumns = [
  "source",
  "kind",
  "lane",
  "source_id",
  "name_original",
  "name_zh",
  "aliases",
  "translation_status",
  "source_url",
  "category",
  "video_count",
  "count_updated_at",
] as const;
export const javbusEntryKey = (entry: JavbusCatalogEntry) =>
  `${entry.dimension}:${entry.lane}:${entry.id}`;
export const javbusEntryUrl = (entry: JavbusCatalogEntry) =>
  `${JAVBUS_ORIGIN}${entry.lane === "uncensored" ? "/uncensored" : ""}/${javbusKinds[entry.dimension]}/${entry.id}`;
const validText = (text: unknown): text is string =>
  typeof text === "string" &&
  !!text &&
  text.trim() === text &&
  text.length <= 128 &&
  !hasControlCharacters(text) &&
  // 单独的角括号属于普通文本；拒绝成对标签，显示仍由 React 按文本转义。
  !/<[^>]*>/.test(text);
const nameKey = (name: string) => name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
export function validJavbusEntry(entry: JavbusCatalogEntry, now: number): boolean {
  return (
    !!entry &&
    Object.hasOwn(javbusKinds, entry.dimension) &&
    ["censored", "uncensored"].includes(entry.lane) &&
    typeof entry.id === "string" &&
    /^[a-z0-9_-]{1,100}$/i.test(entry.id) &&
    validText(entry.name) &&
    validText(entry.label) &&
    Array.isArray(entry.aliases) &&
    entry.aliases.length <= 32 &&
    entry.aliases.every((alias) => validText(alias) && !alias.includes("|")) &&
    ["pending", "translated", "reviewed"].includes(entry.translationStatus) &&
    (entry.category === "" || validText(entry.category)) &&
    (entry.videoCount === undefined
      ? entry.countUpdatedAt === undefined
      : Number.isSafeInteger(entry.videoCount) &&
        entry.videoCount >= 0 &&
        entry.videoCount <= 100_000_000 &&
        Number.isSafeInteger(entry.countUpdatedAt) &&
        entry.countUpdatedAt! > 0 &&
        entry.countUpdatedAt! <= now + 300_000)
  );
}
export function javbusEntryFromEntity(
  entity: AvwikiEntity,
  dimension: JavbusCatalogDimension,
  now: number,
  videoCount?: number,
): JavbusCatalogEntry {
  const parsed = entityOf(entity.url, entity.name, dimension);
  if (!parsed || parsed.url !== entity.url) throw new Error("JavBus 目录身份无效，已保留原名单。");
  const url = new URL(parsed.url);
  const entry: JavbusCatalogEntry = {
    dimension,
    lane: url.pathname.startsWith("/uncensored/") ? "uncensored" : "censored",
    id: url.pathname.split("/").at(-1)!,
    name: entity.name,
    label: entity.name,
    aliases: [],
    translationStatus: "pending",
    category: "",
    ...(videoCount !== undefined ? { videoCount, countUpdatedAt: now } : {}),
  };
  if (!validJavbusEntry(entry, now)) throw new Error("JavBus 目录字段无效，已保留原名单。");
  return entry;
}
export function parseJavbusCsv(csv: string, dimension: JavbusCatalogDimension, now: number) {
  const rows = parseCatalogCsvRows(csv);
  const fail = () => {
    throw new Error("JavBus 目录 CSV 无效，已保留原名单。");
  };
  if (rows.shift()?.join(",") !== javbusCsvColumns.join(",")) fail();
  const seen = new Set<string>();
  return rows.map((row) => {
    const [source, kind, lane, id, name, label, aliases, status, url, category, count, date] = row;
    if (
      row.length !== javbusCsvColumns.length ||
      source !== "javbus" ||
      kind !== javbusKinds[dimension] ||
      (count && !/^\d+$/.test(count)) ||
      (date && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)) ||
      !!count !== !!date
    )
      fail();
    const countUpdatedAt = date ? Date.parse(date) : undefined;
    const entry: JavbusCatalogEntry = {
      dimension,
      lane: lane as GenreLane,
      id: id!,
      name: name!,
      label: label || name!,
      aliases: aliases ? aliases.split("|") : [],
      translationStatus: status as JavbusCatalogEntry["translationStatus"],
      category: category!,
      ...(count ? { videoCount: Number(count), countUpdatedAt } : {}),
    };
    const key = javbusEntryKey(entry);
    if (!validJavbusEntry(entry, now) || url !== javbusEntryUrl(entry) || seen.has(key)) fail();
    seen.add(key);
    return entry;
  });
}
export function serializeJavbusCsv(entries: JavbusCatalogEntry[], now: number) {
  if (entries.length > 100_000) throw new Error("JavBus 目录无法导出。");
  const seen = new Set<string>();
  const rows: (readonly string[])[] = [javbusCsvColumns];
  for (const entry of entries) {
    const key = javbusEntryKey(entry);
    if (!validJavbusEntry(entry, now) || seen.has(key)) throw new Error("JavBus 目录无法导出。");
    seen.add(key);
    rows.push([
      "javbus",
      javbusKinds[entry.dimension],
      entry.lane,
      entry.id,
      entry.name,
      entry.label === entry.name ? "" : entry.label,
      entry.aliases.join("|"),
      entry.translationStatus,
      javbusEntryUrl(entry),
      entry.category,
      entry.videoCount?.toString() ?? "",
      entry.countUpdatedAt === undefined ? "" : new Date(entry.countUpdatedAt).toISOString(),
    ]);
  }
  const csv =
    "\uFEFF" +
    rows
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","))
      .join("\r\n") +
    "\r\n";
  if (csv.length > 16 * 1024 * 1024) throw new Error("JavBus CSV 超过大小限制。");
  return csv;
}

export function javbusActressesUrl(lane: GenreLane, page = 1) {
  if (!Number.isInteger(page) || page < 1 || page > JAVBUS_ACTRESSES_PAGE_LIMIT)
    throw new Error("JavBus 演员目录页号无效。");
  return `${JAVBUS_ORIGIN}${lane === "uncensored" ? "/uncensored" : ""}/actresses${page === 1 ? "" : `/${page}`}`;
}
export function parseJavbusActresses(html: string, lane: GenreLane, page: number, now: number) {
  javbusActressesUrl(lane, page);
  const base = javbusActressesUrl(lane),
    source = documentSource(html);
  const entries = new Map<string, JavbusCatalogEntry>();
  const unnamedIds: string[] = [];
  const seen = new Set<string>();
  let cards = 0,
    nextPage: number | null = null;
  for (const match of anchors(source)) {
    const target = sourceUrl(attribute(match[1]!, "href"), base);
    if (target?.href === `${base}/${page + 1}` && page < JAVBUS_ACTRESSES_PAGE_LIMIT)
      nextPage = page + 1;
    if (!hasClass(match[1]!, "avatar-box")) continue;
    cards++;
    const id =
      target && /^\/(?:uncensored\/)?star\/([a-z0-9_-]{1,100})$/i.exec(target.pathname)?.[1];
    if (
      !id ||
      target!.pathname.startsWith("/uncensored/") !== (lane === "uncensored") ||
      seen.has(id)
    )
      throw new Error("JavBus 演员目录不完整，已保留原名单。");
    seen.add(id);
    if (cards > 100) throw new Error("JavBus 演员分页超过上限。");
    const img = /<img\b([^>]{0,4096})>/i.exec(match[2]!)?.[1] ?? "";
    const name = (
      attribute(img, "title") ||
      attribute(img, "alt") ||
      plain(/<span\b[^>]*>([^]*?)<\/span\s*>/i.exec(match[2]!)?.[1] ?? "")
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!name) {
      unnamedIds.push(id);
      continue;
    }
    const entity = target && entityOf(target.href, name, "actresses");
    if (!entity || target!.pathname.startsWith("/uncensored/") !== (lane === "uncensored"))
      throw new Error("JavBus 演员目录不完整，已保留原名单。");
    const entry = javbusEntryFromEntity(
      entity,
      "actresses",
      now,
      readJavbusVideoCount(match[1]! + ">" + match[2]!),
    );
    entries.set(javbusEntryKey(entry), entry);
    if (entries.size > 100) throw new Error("JavBus 演员分页超过上限。");
  }
  if (!cards || entries.size + unnamedIds.length !== cards)
    throw new Error("未识别到完整 JavBus 演员目录，已保留原名单。");
  return { entries: [...entries.values()], nextPage, ...(unnamedIds.length ? { unnamedIds } : {}) };
}
export function parseJavbusGenres(html: string, lane: GenreLane, known: GenreEntry[], now: number) {
  const source = documentSource(html);
  const entries = parseGenrePage(source, lane, known);
  const metadata = new Map<string, { count?: number; category: string }>();
  const headings = [...source.matchAll(/<h[2-5]\b[^>]*>([^]*?)<\/h[2-5]\s*>/gi)];
  let heading = 0,
    category = "其他";
  // 分类分组标题属于目录元数据；同名分类仍按分区和来源 ID 分别保存。
  for (const match of anchors(source)) {
    const target = sourceUrl(attribute(match[1]!, "href"));
    const id =
      target && /^\/(?:uncensored\/)?genre\/([a-z0-9_-]{1,32})$/i.exec(target.pathname)?.[1];
    if (!id || target!.pathname.startsWith("/uncensored/") !== (lane === "uncensored")) continue;
    while (heading < headings.length && headings[heading]!.index < match.index) {
      const text = plain(headings[heading++]![1]!);
      category = validText(text) ? text : "其他";
    }
    metadata.set(id, {
      count: readJavbusVideoCount(match[1]! + ">" + match[2]!),
      category: validText(category) ? category : "其他",
    });
  }
  return entries.map((entry) => ({
    ...javbusEntryFromEntity(
      {
        id: entry.id,
        name: entry.name,
        url: `${JAVBUS_ORIGIN}${lane === "uncensored" ? "/uncensored" : ""}/genre/${entry.id}`,
      },
      "genres",
      now,
      metadata.get(entry.id)?.count,
    ),
    category: metadata.get(entry.id)?.category ?? entry.category,
  }));
}
export function parseJavbusRelations(html: string, now: number) {
  const source = infoBlock(documentSource(html));
  const entries = new Map<string, JavbusCatalogEntry>();
  for (const match of anchors(source)) {
    const name = plain(match[2]!);
    for (const dimension of Object.keys(javbusKinds) as JavbusCatalogDimension[]) {
      // 详情中的通用演员不能推断男女，女演员名单由明确的目录负责。
      if (dimension === "actresses" || dimension === "maleActors") continue;
      const entity = entityOf(attribute(match[1]!, "href"), name, dimension);
      if (!entity) continue;
      const entry = javbusEntryFromEntity(entity, dimension, now);
      entries.set(javbusEntryKey(entry), entry);
    }
  }
  return [...entries.values()];
}
export function javbusNameIndex(csv: AvwikiEntry[] = []) {
  const index = new Map<string, Set<string>>();
  for (const item of csv)
    for (const name of [item.name, item.label, ...item.aliases]) {
      const key = nameKey(name),
        names = index.get(key) ?? new Set<string>();
      names.add(item.name);
      index.set(key, names);
    }
  return index;
}
export function resolveJavbusCatalogEntities(
  entries: JavbusCatalogEntry[],
  dimension: string,
  names: string[],
): AvwikiEntity[] {
  const wanted = new Set(names.map(nameKey));
  const selected = entries.filter(
    (entry) =>
      entry.dimension === dimension &&
      [entry.name, entry.label, ...entry.aliases].some((name) => wanted.has(nameKey(name))),
  );
  if (selected.length > 50) throw new Error("JavBus 同名来源过多，请确认名称。");
  return selected.map((entry) => {
    const url = javbusEntryUrl(entry);
    return { id: new URL(url).pathname.slice(1).replaceAll("/", ":"), name: entry.name, url };
  });
}
export function matchJavbusName(entry: JavbusCatalogEntry, index = javbusNameIndex()) {
  const wanted = new Set([entry.name, entry.label, ...entry.aliases].map(nameKey));
  const matches = new Set([...wanted].flatMap((key) => [...(index.get(key) ?? [])]));
  return matches.size === 1 ? matches.values().next().value! : entry.name;
}
export function mergeJavbusEntries(
  previous: JavbusCatalogEntry[],
  incoming: JavbusCatalogEntry[],
  now: number,
) {
  const entries = new Map(previous.map((entry) => [javbusEntryKey(entry), entry]));
  for (const entry of incoming) {
    if (!validJavbusEntry(entry, now)) throw new Error("JavBus 目录更新无效，已保留原名单。");
    const key = javbusEntryKey(entry),
      old = entries.get(key);
    entries.set(
      key,
      old
        ? {
            ...old,
            ...entry,
            label:
              old.translationStatus !== "pending" && entry.translationStatus === "pending"
                ? old.label
                : entry.label,
            translationStatus:
              old.translationStatus !== "pending" && entry.translationStatus === "pending"
                ? old.translationStatus
                : entry.translationStatus,
            aliases: [
              ...new Set([
                ...old.aliases,
                ...entry.aliases,
                ...(old.name === entry.name ? [] : [old.name]),
              ]),
            ],
            category: entry.category || old.category,
            ...(old.countUpdatedAt !== undefined &&
            (entry.countUpdatedAt === undefined || old.countUpdatedAt > entry.countUpdatedAt)
              ? { videoCount: old.videoCount, countUpdatedAt: old.countUpdatedAt }
              : {}),
          }
        : entry,
    );
  }
  if (
    entries.size > 100_000 ||
    [...entries.values()].some((entry) => !validJavbusEntry(entry, now))
  )
    throw new Error("JavBus 目录数量或字段超过限制，已保留原名单。");
  return [...entries.values()];
}
