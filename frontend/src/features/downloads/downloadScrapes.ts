import type { DownloadTask } from "../../contracts/downloads";
import type { ScrapeTask } from "../../contracts/scraping";

/** 列表、详情与操作共用关联规则，同时支持复用已有刮削任务和合并后的记录。 */
export function createDownloadScrapeLookup(tasks: readonly ScrapeTask[]) {
  const byDownload = new Map<string, ScrapeTask>();
  const byId = new Map<string, ScrapeTask>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.downloadId) byDownload.set(task.downloadId, task);
  }
  return (download: Pick<DownloadTask, "id" | "scrapeTaskId">) =>
    byDownload.get(download.id) ??
    (download.scrapeTaskId ? byId.get(download.scrapeTaskId) : undefined);
}
