import type { Film, FilmMetadata } from "./data";

export const facetNames = ["演员", "厂商", "系列", "导演", "分类"] as const;
export type FilmFacet = (typeof facetNames)[number];

export function getFilmMetadata(film: Film): FilmMetadata {
  if (film.metadata) return film.metadata;
  const index = (film.id - 1) % 3;
  return {
    originalTitle: `${film.code}_${film.english.replaceAll(" ", "_")}.mp4`,
    premiered: film.missing ? "" : `${film.year}-08-16`,
    actors: film.actor ? [film.actor] : [],
    director: ["高桥直人", "水野航", "佐藤晴"][index]!,
    studio: film.missing ? "" : ["Studio Rouge", "Noir Label", "Velvet Pictures"][index]!,
    series: ["Private Moments", "After Hours", "First Impression"][index]!,
    genres: [film.genre, "中文字幕"],
    resolution: film.quality === "4K" ? "3840×2160" : "1920×1080",
    directory: `D:\\Media\\${film.code}`,
    fileName: `${film.code}.mp4`,
    source: film.missing ? "本地文件" : "本地 NFO",
  };
}

export function getFacetValues(film: Film, facet: FilmFacet): string[] {
  const metadata = getFilmMetadata(film);
  if (facet === "演员") return metadata.actors;
  if (facet === "分类") return metadata.genres;
  const value = metadata[facet === "厂商" ? "studio" : facet === "系列" ? "series" : "director"];
  return value ? [value] : [];
}

export function titleError(value: string): string | undefined {
  if (!value.trim()) return "请输入影片标题";
  if (/[<>:"/\\|?*]/.test(value)) return "标题不能包含文件名禁用字符";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return "标题不能包含文件名禁用字符";
  }
  if (/[. ]$/.test(value)) return "标题不能以空格或句点结尾";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value.trim()))
    return "标题不能使用系统保留名称";
  return undefined;
}
