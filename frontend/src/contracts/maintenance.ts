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
  path: string;
  title: string;
  code: string;
  hash: string;
  size: number | null;
  duration: number;
  resolution: string;
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
