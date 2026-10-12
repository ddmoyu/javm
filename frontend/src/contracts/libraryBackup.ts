export type BackupOperation = "create" | "inspect" | "restore";
export interface BackupInfo {
  path: string;
  works: number;
  resources: number;
  favorites: number;
  rollbackPath?: string;
}
export interface BackupStatus {
  id?: string;
  operation?: BackupOperation;
  state: "idle" | "running" | "completed" | "failed" | "cancelled";
  phase?: string;
  processed?: number;
  total?: number;
  result?: BackupInfo;
  error?: string;
  warning?: string;
}
