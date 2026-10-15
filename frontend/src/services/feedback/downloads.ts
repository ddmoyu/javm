import type { DownloadTask } from "../../contracts/downloads";
import { reportFailure } from "./events";

export function reportDownloadFailure(task: DownloadTask, open = false) {
  return reportFailure(
    {
      module: "downloads",
      title: task.phase === "merge" ? "下载合并失败" : "检测到下载失败",
      message: task.error || "下载未能完成，请查看诊断日志。",
      taskId: task.id,
      url: task.url,
      occurredAt: open ? task.updatedAt : undefined,
      details: {
        phase: task.phase,
        kind: task.kind,
        downloadedBytes: task.downloaded,
        totalBytes: task.total,
        taskRevision: task.revision,
      },
    },
    open,
  );
}
