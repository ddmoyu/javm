export interface LegacyImportSnapshot {
  state: "unchecked" | "none" | "available" | "running" | "completed" | "failed" | "cancelled";
  phase?: "preparing" | "backingUp" | "importing" | "checking" | "cleaningUp";
  sourcePath?: string;
  targetPath?: string;
  bytes?: number;
  currentVideos?: number;
  processed?: number;
  total?: number;
  importedRows?: number;
  backupPath?: string;
  targetBackupPath?: string;
  warning?: string;
  error?: string;
}
