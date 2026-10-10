import type { Film } from "./data";

export interface LibraryFilters {
  actors: string[];
  genres: string[];
  years: string[];
  qualities: string[];
  duration: string;
  size: string;
  metadata: "all" | "complete" | "missing";
}
export const emptyLibraryFilters = (): LibraryFilters => ({
  actors: [],
  genres: [],
  years: [],
  qualities: [],
  duration: "all",
  size: "all",
  metadata: "all",
});
export type LibraryScope = "all" | "favorites";
export type LibrarySort =
  | "added"
  | "year"
  | "code"
  | "title"
  | "duration"
  | "size"
  | "actor"
  | "quality";
export type SortDirection = "asc" | "desc";
export const librarySortOptions: { value: LibrarySort; label: string; direction: SortDirection }[] =
  [
    { value: "added", label: "入库时间", direction: "desc" },
    { value: "year", label: "发行年份", direction: "desc" },
    { value: "code", label: "番号", direction: "asc" },
    { value: "title", label: "片名", direction: "asc" },
    { value: "duration", label: "影片时长", direction: "desc" },
    { value: "size", label: "文件大小", direction: "desc" },
    { value: "actor", label: "演员", direction: "asc" },
    { value: "quality", label: "画质", direction: "desc" },
  ];
export const durationOptions = [
  { value: "all", label: "全部时长", min: 0, max: Infinity },
  { value: "short", label: "不足 90 分钟", min: 0, max: 90 },
  { value: "medium", label: "90–119 分钟", min: 90, max: 120 },
  { value: "long", label: "120 分钟及以上", min: 120, max: Infinity },
];
export const sizeOptions = [
  { value: "all", label: "全部大小", min: 0, max: Infinity },
  { value: "small", label: "不足 4 GB", min: 0, max: 4 },
  { value: "medium", label: "4–8 GB", min: 4, max: 8 },
  { value: "large", label: "8–12 GB", min: 8, max: 12 },
  { value: "largest", label: "12 GB 及以上", min: 12, max: Infinity },
];
export const metadataOptions = [
  { value: "all", label: "全部状态" },
  { value: "complete", label: "资料完整" },
  { value: "missing", label: "资料待补全" },
];
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
export function filmSizeGB(size: string) {
  const value = Number.parseFloat(size) || 0;
  const unit = size.trim().toUpperCase();
  return unit.endsWith("TB")
    ? value * 1024
    : unit.endsWith("MB")
      ? value / 1024
      : unit.endsWith("KB")
        ? value / (1024 * 1024)
        : value;
}
const resolution = (quality: string) => (quality === "4K" ? 2160 : Number.parseInt(quality) || 0);

export function selectLibraryFilms(
  films: readonly Film[],
  {
    filters,
    scope,
    query,
    sort,
    direction,
  }: {
    filters: LibraryFilters;
    scope: LibraryScope;
    query: string;
    sort: LibrarySort;
    direction: SortDirection;
  },
): Film[] {
  const text = query.trim().toLocaleLowerCase();
  const duration =
    durationOptions.find((option) => option.value === filters.duration) ?? durationOptions[0]!;
  const size = sizeOptions.find((option) => option.value === filters.size) ?? sizeOptions[0]!;
  const matches = films.filter((film) => {
    const gb = filmSizeGB(film.size);
    return (
      `${film.title} ${film.code} ${film.actor ?? ""}`.toLocaleLowerCase().includes(text) &&
      (scope !== "favorites" || film.favorite) &&
      (!filters.actors.length || filters.actors.includes(film.actor ?? "")) &&
      (!filters.genres.length || filters.genres.includes(film.genre)) &&
      (!filters.years.length || filters.years.includes(String(film.year))) &&
      (!filters.qualities.length || filters.qualities.includes(film.quality)) &&
      film.duration >= duration.min &&
      film.duration < duration.max &&
      gb >= size.min &&
      gb < size.max &&
      (filters.metadata === "all" ||
        (filters.metadata === "missing" ? film.missing : !film.missing))
    );
  });
  const sign = direction === "asc" ? 1 : -1;
  return matches.sort((a, b) => {
    const compared =
      sort === "year"
        ? a.year - b.year
        : sort === "code"
          ? collator.compare(a.code, b.code)
          : sort === "title"
            ? collator.compare(a.title, b.title)
            : sort === "duration"
              ? a.duration - b.duration
              : sort === "size"
                ? filmSizeGB(a.size) - filmSizeGB(b.size)
                : sort === "actor"
                  ? collator.compare(a.actor ?? "", b.actor ?? "")
                  : sort === "quality"
                    ? resolution(a.quality) - resolution(b.quality)
                    : a.id - b.id;
    return compared * sign || a.id - b.id;
  });
}
