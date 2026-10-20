export type MaintenanceMode = "duplicates" | "ads" | "health" | "all";
export interface AdRules {
  keywords: string[];
  excludeKeywords: string[];
  duplicateNames: boolean;
}
export const defaultAdRules: AdRules = {
  keywords: ["全網網黃國"],
  excludeKeywords: [],
  duplicateNames: true,
};
export interface MaintenanceVideo {
  id: string;
  workId?: string;
  path: string;
  title: string;
  code: string;
  hash: string;
  size: number | null;
  duration: number;
  resolution: string;
  codec?: string;
  /** 视频流码率（bit/s）；旧记录或探测不支持时为空。 */
  bitrate?: number | null;
  part?: number;
  parts?: number;
  missing: boolean;
  issues?: string[];
}
export interface MaintenanceRow extends MaintenanceVideo {
  group: string;
  groupId: string;
  reason: string;
  crossDirectory: boolean;
  suggested: boolean;
  suggestedKeep: boolean;
  selected: boolean;
  advice?: string;
  review?: boolean;
}
export interface RemovalTarget {
  id: string;
  path: string;
  retained?: { id: string; path: string };
}
export interface MaintenancePage {
  rows: MaintenanceRow[];
  total: number;
  groups: number;
  selected: number;
  suggested: number;
  suggestedBytes: number;
  selectedBytes: number;
  review: number;
  unprotected: number;
  unhashed: number;
  page: number;
}
export const maintenancePageSize = 30;
export type MaintenanceCommand =
  | { type: "reset"; mode: MaintenanceMode; rules: AdRules }
  | { type: "append"; rows: MaintenanceVideo[] }
  | { type: "finish" }
  | { type: "page"; page: number }
  | { type: "select"; ids?: string[]; choice: "all" | "none" | "suggested" | "toggle" }
  | { type: "selected"; after: number }
  | { type: "removed"; ids: string[] };
export interface RemovalPlan {
  token: string;
  files: { path: string; stamp: string }[];
  preserved: number;
}
export interface WorkRemovalPreview {
  id: string;
  title: string;
  files: {
    path: string;
    stamp: string;
    kind: "video" | "nfo" | "image" | "backup";
    exists: boolean;
  }[];
  preservedFiles: { path: string; reason: string }[];
}
