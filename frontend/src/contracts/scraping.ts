import type { MovieCandidate } from "../services/metadata/MetaTubeService";

export type ScrapeStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "needsInput"
  | "cancelled"
  | "interrupted";
export type ScrapePhase = "prepare" | "search" | "details" | "artwork" | "save";
export interface ScrapeTask {
  id: string;
  revision: number;
  name: string;
  workId?: string;
  collect?: boolean;
  path?: string;
  downloadId?: string;
  query?: string;
  candidate?: MovieCandidate;
  status: ScrapeStatus;
  phase: ScrapePhase;
  error: string;
  createdAt: string;
  updatedAt: string;
}
export const scrapeLabels: Record<ScrapeStatus, string> = {
  queued: "等待刮削",
  running: "刮削中",
  completed: "刮削完成",
  partial: "部分完成",
  failed: "刮削失败",
  needsInput: "待确认番号",
  cancelled: "已取消",
  interrupted: "已中断",
};
export const scrapePhaseLabels: Record<ScrapePhase, string> = {
  prepare: "检查并入库",
  search: "匹配番号",
  details: "读取资料",
  artwork: "下载封面",
  save: "保存资料与 NFO",
};
export const activeScrape = (task: ScrapeTask) =>
  task.status === "queued" || task.status === "running";
