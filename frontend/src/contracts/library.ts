export type ScanState =
  | "idle"
  | "scanning"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface MediaDirectory {
  id: string;
  path: string;
  video_count: number;
  recursive: boolean;
  formats: string[];
  state: ScanState;
  error: string;
  scanned_at: string | null;
}
export interface ScanProgress {
  id: string;
  directoryId: string;
  state: ScanState;
  discovered: number;
  processed: number;
  imported: number;
  unchanged: number;
  skipped: number;
  errors: number;
  current: string;
  issues: { path: string; message: string }[];
  concurrency: number;
  activeProbes: number;
  peakProbes: number;
  warnings: number;
  notices: { path: string; message: string }[];
}
export interface LibraryStatus {
  recoveryError?: string;
  directories: MediaDirectory[];
  scan: ScanProgress | null;
  revision: number;
  databasePath: string;
  metadataDirectory?: string;
  assetRoots?: { id: string; path: string }[];
  logicalProcessors?: number;
  defaultConcurrency?: number;
  maxConcurrency?: number;
}
export interface DirectoryInput {
  path: string;
  recursive: boolean;
  formats: string[];
}
export interface NativeVideo {
  /** 用户主动刮削后保存的预览链接，读取片库时不请求 MetaTube。 */
  preview?: {
    homepage?: string;
    previewVideoUrl?: string;
    previewVideoHlsUrl?: string;
    previewImages?: string[];
  };
  screenshots?: { id: string; path: string; kind: "screenshot" | "sheet"; seconds: number }[];
  plot?: string;
  metadata_edited?: boolean;
  id: string;
  local_id: string | null;
  title: string | null;
  original_title: string | null;
  studio: string | null;
  label?: string;
  director: string | null;
  premiered: string | null;
  duration: number | null;
  /** SQLite / NFO 的 10 分制评分，由 LibraryService 换算为界面的 5 分制。 */
  rating: number | null;
  video_path: string | null;
  availability?: "metadata_only" | "available" | "unavailable";
  media_files?: {
    id: string;
    path: string;
    file_size: number | null;
    missing: number;
    stream_url?: string | null;
    part?: number;
    parts?: number;
  }[];
  nfo_files?: { path: string; canonical: number }[];
  dir_path: string;
  file_size: number | null;
  poster: string | null;
  thumb?: string | null;
  fanart?: string | null;
  year?: number;
  tags?: string[];
  resolution: string | null;
  scan_status: number | null;
  created_at: string;
  width: number;
  height: number;
  favorite: number;
  missing: number;
  nfo_path: string;
  actors: string[];
  genres: string[];
  series: string;
}

export interface LibraryFilters {
  actors: string[];
  genres: string[];
  years: string[];
  qualities: string[];
  duration: string;
  size: string;
  metadata: "all" | "complete" | "missing";
}
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
export type FacetDimension =
  | "actors"
  | "actresses"
  | "maleActors"
  | "genres"
  | "studios"
  | "labels"
  | "directors"
  | "series"
  | "years"
  | "qualities";
export interface LibraryQuery {
  availability?: "all" | "metadata_only" | "available" | "unavailable";
  query?: string;
  scope?: LibraryScope;
  sort?: LibrarySort;
  direction?: SortDirection;
  filters?: LibraryFilters;
  facet?: { dimension: FacetDimension; value: string };
}
export interface FacetQuery {
  dimension: FacetDimension;
  query?: string;
  sort?: "name" | "source" | "videoCount";
  names?: string[];
  favoritesOnly?: boolean;
}
export interface FacetValue {
  label?: string;
  name: string;
  count: number;
  /** JavBus 明确提供的影片数；缺失时不可用本地数量代替。 */
  videoCount?: number | null;
  favorite?: boolean | number;
}
export interface LibrarySummary {
  total: number;
  favorites: number;
}
export interface PageRequest {
  offset: number;
  limit: number;
  includeTotal: boolean;
}
export interface QueryPage<T> {
  items: T[];
  offset: number;
  total?: number;
  available?: number;
}
