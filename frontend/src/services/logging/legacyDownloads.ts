import type { DownloadTask } from "../../contracts/downloads";
import { redactLog } from "../downloads/input";
import { flushLogs, logEvent } from "./events";
import { logPolicy } from "./RotatingLogStore";

// 旧任务最多保存 80 行。近期记录进入统一日志，过期记录随本次正常保存清理。
export async function importDownloadLog(task: DownloadTask, cancelled = () => false) {
  if (cancelled() || !Array.isArray(task.log)) return false;
  const updated = Date.parse(task.updatedAt);
  if (!Number.isFinite(updated) || Date.now() - updated > logPolicy.days * 86400000) return true;
  const lines = task.log.slice(-80);
  if (!(await flushLogs())) return false;
  for (let start = 0; start < lines.length; start += 16) {
    if (cancelled()) return false;
    for (const line of lines.slice(start, start + 16))
      if (typeof line === "string")
        logEvent("info", "downloads", "legacy_output", redactLog(line, task), {
          taskId: task.id,
          previousUpdatedAt: task.updatedAt,
        });
    // 写入失败或超时不清除旧副本，下次启动重试。
    if (!(await flushLogs())) return false;
  }
  return true;
}
