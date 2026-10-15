import type { DownloadTask } from "../../contracts/downloads";
import { identifyCode, normalizeCode } from "../scraping/identity";

export interface DuplicateDownloadConfirmation {
  id: string;
  codes: string[];
  count: number;
}

export class DuplicateDownloadError extends Error {
  constructor(
    readonly codes: string[],
    readonly count: number,
  ) {
    super("相同番号已有下载任务，请确认是否继续添加。");
    this.name = "DuplicateDownloadError";
  }
}

export class DownloadAdditionCancelledError extends Error {
  constructor() {
    super("已取消新下载任务。");
    this.name = "DownloadAdditionCancelledError";
  }
}

export const downloadCode = (task: Pick<DownloadTask, "code" | "name">) =>
  task.code?.trim() || identifyCode(task.name);

export function duplicateDownloadCodes(tasks: DownloadTask[], existing: DownloadTask[]) {
  const codes = new Set<string>();
  const works = new Set<string>();
  const duplicates = new Map<string, string>();
  const remember = (task: DownloadTask) => {
    const code = downloadCode(task);
    if (code) codes.add(normalizeCode(code));
    if (task.workId) works.add(task.workId);
  };
  existing.forEach(remember);
  for (const task of tasks) {
    const code = downloadCode(task);
    if (code) {
      const key = normalizeCode(code);
      if (codes.has(key) || (task.workId && works.has(task.workId))) duplicates.set(key, code);
    }
    remember(task);
  }
  return [...duplicates.values()];
}
