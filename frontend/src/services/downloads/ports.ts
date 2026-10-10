import type { DownloadSettings, DownloadTask } from "../../contracts/downloads";

// A failed kill must not be presented as a paused task or free a process slot.
export class StopUnconfirmedError extends Error {
  constructor(readonly retry: () => Promise<void>) {
    super("未能确认下载进程已停止，请重试停止任务后再继续或退出。");
    this.name = "StopUnconfirmedError";
  }
}

export interface DownloadRepository {
  beginShutdown?(): void;
  load(): Promise<{ tasks: DownloadTask[]; settings: Partial<DownloadSettings> }>;
  save(task: DownloadTask, expectedRevision: number): Promise<void>;
  remove(id: string, revision: number): Promise<void>;
  saveSettings(settings: DownloadSettings): Promise<void>;
  close(): Promise<void>;
}

export interface DownloadProgress {
  progress?: number | null;
  downloaded?: number;
  total?: number;
  totalIsEstimate?: boolean;
  outputSize?: number;
  speed?: number;
  line?: string;
}

export interface DownloadEngine {
  defaultDirectory(): Promise<string>;
  outputSize(path: string): Promise<number | null>;
  run(
    task: DownloadTask,
    settings: DownloadSettings,
    signal: AbortSignal,
    progress: (update: DownloadProgress) => void,
    stage: (phase: DownloadTask["phase"], inputs?: string[]) => Promise<void>,
  ): Promise<void>;
  open(path: string): Promise<void>;
  checkTools(settings: DownloadSettings): Promise<string[]>;
}
