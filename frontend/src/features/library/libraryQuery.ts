import type { LibraryFilters, LibrarySort, SortDirection } from "../../contracts/library";
export type {
  LibraryFilters,
  LibrarySort,
  LibraryScope,
  SortDirection,
} from "../../contracts/library";
export const emptyLibraryFilters = (): LibraryFilters => ({
  actors: [],
  genres: [],
  years: [],
  qualities: [],
  duration: "all",
  size: "all",
  metadata: "all",
});
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
