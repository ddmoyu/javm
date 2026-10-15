export interface MediaImage {
  id?: string;
  path?: string;
  src: string;
  title?: string;
  timestamp?: string;
}
export interface MediaTrailer {
  src: string;
  format?: "video" | "hls";
}
export interface MediaFile {
  part?: number;
  parts?: number;
  id?: string;
  streamUrl?: string;
  missing?: boolean;
  name: string;
  path: string;
  size?: string;
  kind: "video" | "image" | "metadata";
}

export interface FilmMetadata {
  plot?: string;
  originalTitle: string;
  premiered: string;
  actors: string[];
  director: string;
  studio: string;
  label?: string;
  series: string;
  genres: string[];
  tags?: string[];
  resolution: string;
  directory: string;
  fileName: string;
  source: string;
  sourceId?: string;
  homepage?: string;
}
export interface Film {
  availability?: "metadata_only" | "available" | "unavailable";
  id: string | number;
  code: string;
  title: string;
  english: string;
  year: number;
  duration: number;
  durationSeconds?: number;
  createdAt?: string;
  fileMissing?: boolean;
  /** 界面与资料编辑统一使用 5 分制；缺少评分时不赋值。 */
  rating?: number;
  genre: string;
  quality: string;
  size: string;
  favorite: boolean;
  missing: boolean;
  actor?: string;
  metadata?: FilmMetadata;
  coverUrl?: string;
  artwork?: MediaImage[];
  trailers?: MediaTrailer[];
  screenshots?: MediaImage[];
  files?: MediaFile[];
}

export type TaskStatus =
  | "downloading"
  | "queued"
  | "merging"
  | "paused"
  | "failed"
  | "completed"
  | "scrapeFailed"
  | "scraping"
  | "cancelled";
export interface DownloadTask {
  id: number;
  filmId?: number;
  resourceId?: string;
  quality?: Film["quality"];
  name: string;
  status: TaskStatus;
  progress: number;
  path: string;
  speed?: string;
  remaining?: string;
}
export const taskLabels: Record<TaskStatus, string> = {
  downloading: "下载中",
  queued: "等待中",
  merging: "合并中",
  paused: "已暂停",
  failed: "下载失败",
  completed: "已完成",
  scrapeFailed: "刮削失败",
  scraping: "刮削中",
  cancelled: "已停止",
};
