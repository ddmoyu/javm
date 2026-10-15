import type { ScrapeTask } from "../../contracts/scraping";
import { identifyCode, normalizeCode } from "./identity";

type Target = Pick<ScrapeTask, "workId" | "path" | "downloadId" | "candidate">;

export function scrapeTarget(task: Target) {
  const candidate = task.candidate;
  const code = candidate?.code ? identifyCode(candidate.code) : undefined;
  return {
    // 文件任务按具体文件区分，不能把同一作品的不同视频/分卷合并。
    path: (task.path ?? "").replaceAll("\\", "/").toLowerCase(),
    workId: task.workId,
    downloadId: task.downloadId,
    source:
      candidate?.provider && candidate.id ? JSON.stringify([candidate.provider, candidate.id]) : "",
    code: code && normalizeCode(code) === normalizeCode(candidate!.code) ? normalizeCode(code) : "",
  };
}

export function sameScrapeTarget(
  left: ReturnType<typeof scrapeTarget>,
  right: ReturnType<typeof scrapeTarget>,
) {
  if (left.downloadId && left.downloadId === right.downloadId) return true;
  if (left.path || right.path) return !!left.path && left.path === right.path;
  // 两个已确认的片库身份冲突时，不再按来源或番号猜测。
  if (left.workId && right.workId) return left.workId === right.workId;
  return !!(
    (left.source && left.source === right.source) ||
    (left.code && left.code === right.code)
  );
}

export function mergeScrapeHistory(keep: ScrapeTask, other: ScrapeTask): ScrapeTask {
  const latest = other.updatedAt >= keep.updatedAt ? other : keep;
  const previous = latest === keep ? other : keep;
  return {
    ...latest,
    id: keep.id,
    revision: keep.revision,
    createdAt: keep.createdAt,
    workId: latest.workId || previous.workId,
    path: latest.path || previous.path,
    downloadId: latest.downloadId || previous.downloadId,
    collect: latest.collect || previous.collect,
  };
}
