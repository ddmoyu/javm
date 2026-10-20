import type { Film } from "./media";
import { getFilmMetadata } from "../features/films/filmMetadata";
export interface EditableMetadata {
  title: string;
  originalTitle: string;
  code: string;
  plot: string;
  premiered: string;
  duration: number;
  /** 0 表示未评分，有效评分为 0～5。 */
  rating: number;
  director: string;
  studio: string;
  label: string;
  series: string;
  actors: string[];
  genres: string[];
  tags: string[];
}
export const metadataLabels: Record<keyof EditableMetadata, string> = {
  title: "标题",
  originalTitle: "原标题",
  code: "番号",
  plot: "简介",
  premiered: "发行日期",
  duration: "时长（分钟）",
  rating: "评分（5 分制）",
  director: "导演",
  studio: "制作商",
  label: "发行商",
  series: "系列",
  actors: "演员",
  genres: "分类",
  tags: "标签",
};
export function editableMetadata(film: Film): EditableMetadata {
  const metadata = getFilmMetadata(film);
  return {
    title: film.title,
    code: film.code,
    duration: film.duration,
    rating: film.rating ?? 0,
    originalTitle: metadata.originalTitle,
    plot: metadata.plot ?? "",
    premiered: metadata.premiered,
    director: metadata.director,
    studio: metadata.studio,
    label: metadata.label ?? "",
    series: metadata.series,
    actors: metadata.actors,
    genres: metadata.genres,
    tags: metadata.tags ?? [],
  };
}
export function metadataChanges(before: EditableMetadata, after: EditableMetadata) {
  return Object.fromEntries(
    (Object.keys(metadataLabels) as (keyof EditableMetadata)[])
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => [key, after[key]]),
  ) as Partial<EditableMetadata>;
}
