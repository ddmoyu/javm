export type DownloadStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "merging"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadTask {
  rename?: { name: string; output: string; operationId: string };
  workId?: string;
  id: string;
  revision: number;
  name: string;
  url: string;
  kind: "hls" | "http";
  headers: Record<string, string>;
  directory: string;
  output: string;
  workDirectory: string;
  status: DownloadStatus;
  phase: "download" | "merge";
  inputs: string[];
  progress: number | null;
  downloaded: number;
  total: number;
  totalIsEstimate?: boolean;
  outputSize?: number;
  speed: number;
  error: string;
  log: string[];
  createdAt: string;
  updatedAt: string;
  /** 仅新建或显式重试后处理的任务自动接入刮削，旧记录不会批量回填。 */
  scrapeAfterDownload?: boolean;
  scrapeHandoffError?: string;
  scrapeTaskId?: string;
}

export interface DownloadSettings {
  directory: string;
  concurrency: number;
  ffmpegPath: string;
  curlPath: string;
}

export interface NewDownload {
  workId?: string;
  urls: string[];
  directory: string;
  name?: string;
  kind: "auto" | "hls" | "http";
  headers: Record<string, string>;
}

export const downloadLabels: Record<DownloadStatus, string> = {
  queued: "等待中",
  preparing: "准备中",
  downloading: "下载中",
  merging: "合并中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export const defaultDownloadSettings: DownloadSettings = {
  directory: "",
  concurrency: 2,
  ffmpegPath: "",
  curlPath: "",
};

// 包括暂停、失败和已完成记录；满额后由用户移除记录，不自动删除文件。
export const downloadTaskLimit = 1000;

export const isRunning = (status: DownloadStatus) =>
  status === "preparing" || status === "downloading" || status === "merging";

export const canResume = (status: DownloadStatus) =>
  status === "paused" || status === "failed" || status === "cancelled";
