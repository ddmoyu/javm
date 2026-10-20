import type { Film, FilmMetadata } from "../../contracts/media";

export const facetNames = ["演员", "制作商", "发行商", "系列", "导演", "分类"] as const;
export type FilmFacet = (typeof facetNames)[number];

export function getFilmMetadata(film: Film): FilmMetadata {
  if (film.metadata) return film.metadata;
  return {
    originalTitle: "",
    premiered: "",
    actors: film.actor ? [film.actor] : [],
    director: "",
    studio: "",
    series: "",
    genres: film.genre ? [film.genre] : [],
    resolution: "",
    directory: "",
    fileName: "",
    source: "",
  };
}

export function getFacetValues(film: Film, facet: FilmFacet): string[] {
  const metadata = getFilmMetadata(film);
  if (facet === "演员") return metadata.actors;
  if (facet === "分类") return metadata.genres;
  const value =
    metadata[
      facet === "制作商"
        ? "studio"
        : facet === "发行商"
          ? "label"
          : facet === "系列"
            ? "series"
            : "director"
    ];
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
