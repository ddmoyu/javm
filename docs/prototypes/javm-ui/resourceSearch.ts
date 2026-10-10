import { sampleFilms } from "./data";
import type { DownloadTask, Film } from "./data";
import { getFilmMetadata } from "./filmMetadata";

export const resourceSources = [
  { id: "metadata", name: "资料源 A", type: "影片资料" },
  { id: "online", name: "视频源 A", type: "在线视频" },
  { id: "magnet-a", name: "磁力源 A", type: "磁力" },
  { id: "magnet-b", name: "磁力源 B", type: "磁力" },
] as const;
export type SourceId = (typeof resourceSources)[number]["id"];
export type SourceState = "searching" | "ready" | "empty" | "error" | "stopped";
export interface ResourceResult {
  id: string;
  code: string;
  name: string;
  kind: "magnet" | "online";
  quality: "4K" | "1080P" | "720P";
  size: number;
  seeders: number | null;
  available: boolean;
  date: string;
  sources: SourceId[];
  url: string;
}
export type ResourceSort = "recommended" | "seeders" | "size" | "date";
export interface ResourceMatch {
  code: string;
  film?: Film;
  libraryId?: number;
  metadataSources?: string[];
  aliases?: string[];
}
export interface ResourcePacket {
  sources: Record<SourceId, SourceState>;
  resources: ResourceResult[];
}
export const resourcePageSize = 12;

// 同一影片的站点资料与片库记录合并；独立作品才保留为新结果。
const remoteSearchFilms: Film[] = sampleFilms.slice(0, 4).map((film, index) => {
  const remote = {
    ...film,
    id: 6001 + index,
    code: `JVM-${6001 + index}`,
    title: ["海边的信", "秋日旅途", "城市微光", "北方来客"][index]!,
    english: ["LETTERS BY THE SEA", "AUTUMN JOURNEY", "CITY GLOW", "NORTHERN VISITOR"][index]!,
    year: 2026,
    duration: [95, 102, 111, 98][index]!,
    coverFrame: index,
    favorite: false,
    missing: false,
  };
  return {
    ...remote,
    metadata: { ...getFilmMetadata(remote), source: "资料源 A", directory: "", fileName: "" },
  };
});

export function normalizeResourceCode(value: string) {
  const match = /^([a-z]{2,10})[-_\s]?(\d{2,6})$/i.exec(value.trim());
  return match ? `${match[1]!.toUpperCase()}-${String(Number(match[2])).padStart(3, "0")}` : null;
}

export function mergeFilmSearchResults(hits: ResourceMatch[]): ResourceMatch[] {
  const merged = new Map<string, ResourceMatch>();
  for (const hit of hits) {
    const code = normalizeResourceCode(hit.code) ?? hit.code.trim().toUpperCase();
    const previous = merged.get(code);
    const film =
      !previous?.film || (previous.libraryId === undefined && hit.libraryId !== undefined)
        ? hit.film
        : previous.film;
    merged.set(code, {
      code,
      film: film ? { ...film, code } : undefined,
      libraryId: previous?.libraryId ?? hit.libraryId,
      metadataSources: [
        ...new Set([...(previous?.metadataSources ?? []), ...(hit.metadataSources ?? [])]),
      ],
      aliases: [
        ...new Set([
          ...(previous?.aliases ?? []),
          ...(hit.aliases ?? []),
          hit.film?.title ?? "",
          hit.film?.actor ?? "",
        ]),
      ].filter(Boolean),
    });
  }
  return [...merged.values()];
}

export function matchResourceQuery(query: string, films: Film[]): ResourceMatch[] {
  const code = normalizeResourceCode(query);
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [];
  const local = films.map((film) => ({
    code: film.code,
    film,
    libraryId: film.id,
    metadataSources: ["本地片库"],
  }));
  const catalog = mergeFilmSearchResults([
    ...local.slice(0, 12),
    ...sampleFilms.slice(0, 12).map((film) => ({
      code: `jvm_${String(film.id).padStart(4, "0")}`,
      film,
      metadataSources: ["资料源 A"],
    })),
    ...remoteSearchFilms.map((film) => ({ code: film.code, film, metadataSources: ["资料源 A"] })),
    ...local.slice(12),
  ]);
  const exact = code && catalog.find((match) => match.code === code);
  const matches = exact
    ? [exact]
    : catalog.filter(
        (match) =>
          match.code.toLowerCase().includes(text) ||
          match.aliases?.some((alias) => alias.toLocaleLowerCase().includes(text)),
      );
  matches.sort(
    (a, b) =>
      Number(b.film?.title.toLocaleLowerCase() === text) -
      Number(a.film?.title.toLocaleLowerCase() === text),
  );
  return matches.length ? matches : code ? [{ code }] : [];
}

export function createResourcePacket(status: SourceState = "searching"): ResourcePacket {
  return {
    sources: { metadata: status, online: status, "magnet-a": status, "magnet-b": status },
    resources: [],
  };
}

// 纯本地示例：不请求站点，也不生成可用的真实资源地址。
export function sampleResourceResults(code: string): ResourceResult[] {
  const online: ResourceResult[] = ["1080P", "4K", "720P", "1080P"].map((quality, index) => ({
    id: `${code}:online:${index}`,
    code,
    name: `${code}.${quality}.${index === 3 ? "HLS" : "WEB-DL"}.${index === 1 ? "H265" : "H264"}`,
    kind: "online",
    quality: quality as ResourceResult["quality"],
    size: [4.2, 9.8, 1.6, 3.8][index]!,
    seeders: null,
    available: index !== 3,
    date: `2026-10-${String(8 - index).padStart(2, "0")}`,
    sources: ["online"],
    url: `https://media.example.invalid/${code}/${index}.mp4`,
  }));
  const magnets: ResourceResult[] = Array.from({ length: 8 }, (_, index) => {
    const quality = (["4K", "1080P", "1080P", "720P"] as const)[index % 4]!;
    const hash =
      Array.from(code, (letter) => letter.charCodeAt(0).toString(16))
        .join("")
        .padEnd(38, "0")
        .slice(0, 38) + index.toString(16).padStart(2, "0");
    return {
      id: `magnet:${hash}`,
      code,
      name: `${code}.${quality}.${index % 2 ? "H264" : "H265"}.${index < 4 ? "WEB-DL" : "BluRay"}.mkv`,
      kind: "magnet",
      quality,
      size: [9.8, 4.6, 3.6, 1.8, 12.4, 5.2, 3.2, 1.2][index]!,
      seeders: [96, 42, null, 18, 0, 27, 6, null][index]!,
      available: true,
      date: `2026-10-${String(8 - index).padStart(2, "0")}`,
      sources: index < 2 ? ["magnet-a", "magnet-b"] : [index < 5 ? "magnet-a" : "magnet-b"],
      url: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(`${code} ${quality}`)}`,
    };
  });
  return [...online, ...magnets];
}

function resourceIdentity(resource: ResourceResult) {
  try {
    const url = new URL(resource.url);
    if (resource.kind === "magnet") {
      const hash = url.searchParams
        .getAll("xt")
        .find((value) => /^urn:btih:[a-f\d]{40}$/i.test(value));
      if (hash) return hash.toLowerCase();
    } else if (["https:", "http:"].includes(url.protocol)) {
      url.hash = "";
      return `online:${url.href}`;
    }
  } catch {
    /* 无法识别的地址保留来源标识，不按名称猜测同一文件。 */
  }
  return `${resource.kind}:${resource.id}`;
}

export function mergeResourceResults(current: ResourceResult[], incoming: ResourceResult[]) {
  const merged = new Map<string, ResourceResult>();
  for (const resource of [...current, ...incoming]) {
    const identity = resourceIdentity(resource);
    const existing = merged.get(identity);
    merged.set(identity, {
      ...resource,
      id: existing?.id ?? resource.id,
      seeders: resource.seeders ?? existing?.seeders ?? null,
      available: resource.available || !!existing?.available,
      sources: [...new Set([...(existing?.sources ?? []), ...resource.sources])],
    });
  }
  return [...merged.values()];
}

export function sortResourceResults(resources: ResourceResult[], sort: ResourceSort) {
  const availability = (resource: ResourceResult) =>
    !resource.available
      ? 0
      : resource.seeders === 0
        ? 1
        : resource.kind === "magnet" && resource.seeders === null
          ? 2
          : 3;
  return [...resources].sort((a, b) => {
    if (sort === "size") return b.size - a.size;
    if (sort === "date") return b.date.localeCompare(a.date);
    if (sort === "seeders") return (b.seeders ?? -1) - (a.seeders ?? -1);
    return (
      availability(b) - availability(a) ||
      { "4K": 3, "1080P": 2, "720P": 1 }[b.quality] -
        { "4K": 3, "1080P": 2, "720P": 1 }[a.quality] ||
      (b.seeders ?? -1) - (a.seeders ?? -1)
    );
  });
}

export function isResourceQueued(resource: ResourceResult, tasks: DownloadTask[], film?: Film) {
  return tasks.some(
    (task) =>
      !["completed", "cancelled", "failed", "scrapeFailed"].includes(task.status) &&
      (task.resourceId === resource.id ||
        (!task.resourceId &&
          film &&
          task.filmId === film.id &&
          (task.quality ?? film.quality) === resource.quality)),
  );
}

export function resourceDownloadTask(
  resource: ResourceResult,
  tasks: DownloadTask[],
  film?: Film,
): DownloadTask {
  return {
    id: Math.max(0, ...tasks.map((task) => task.id)) + 1,
    resourceId: resource.id,
    filmId: film?.id,
    quality: resource.quality,
    name: film ? `${film.code} · ${film.title}` : resource.name,
    status: "queued",
    progress: 0,
    path: "D:\\Media\\Downloads",
  };
}
