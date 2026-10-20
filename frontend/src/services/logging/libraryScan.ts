import type { ScanIssue, ScanIssueStage, ScanProgress } from "../../contracts/library";
import { logEvent } from "./events";

const stages: Record<ScanIssueStage, string> = {
  enumerate: "目录枚举",
  file: "文件信息读取",
  probe: "媒体探测",
  fingerprint: "文件指纹读取",
  nfo: "NFO 处理",
  artwork: "本地图片关联",
  database: "数据库写入",
  finalize: "扫描收尾",
  scan: "扫描任务",
};
const sampleLimit = 30;
function stageOf(issue: ScanIssue): ScanIssueStage {
  if (issue.stage && Object.hasOwn(stages, issue.stage)) return issue.stage;
  return issue.message === "媒体探测超时" ? "probe" : "scan";
}
function recordDiagnostics(scan: ScanProgress) {
  // 保留失败对象和错误原因，凭据与用户名由统一日志清理器处理。
  for (const [index, issue] of scan.issues.slice(0, sampleLimit).entries()) {
    const stage = stageOf(issue);
    logEvent(
      "warn",
      "library",
      "scan_issue",
      issue.message || `${stages[stage]}失败`,
      {
        taskId: scan.id,
        index: index + 1,
        stage,
        extension: /^[a-z0-9]{1,12}$/i.test(issue.extension ?? "") ? issue.extension! : "unknown",
        ...(issue.sizeBytes !== undefined ? { sizeBytes: issue.sizeBytes } : {}),
        ...(issue.elapsedMs !== undefined ? { elapsedMs: issue.elapsedMs } : {}),
      },
      { action: "scan", filePath: issue.path },
    );
  }
  const counts = scan.errorCounts ?? {};
  if (!scan.errorCounts)
    for (const issue of scan.issues.slice(0, sampleLimit)) {
      const stage = stageOf(issue);
      counts[stage] = (counts[stage] ?? 0) + 1;
    }
  for (const stage of Object.keys(stages) as ScanIssueStage[]) {
    const count = counts[stage];
    if (count)
      logEvent("warn", "library", "scan_error_count", `${stages[stage]}异常统计`, {
        taskId: scan.id,
        stage,
        count,
        sampled: !scan.errorCounts,
      });
  }
  if (scan.errors)
    logEvent(
      "info",
      "library",
      "scan_issue_samples",
      "扫描异常样本有数量上限，completeCounts 表示是否取得全部错误的阶段统计。",
      {
        taskId: scan.id,
        errors: scan.errors,
        recorded: Math.min(scan.issues.length, sampleLimit),
        omitted: Math.max(0, scan.errors - Math.min(scan.issues.length, sampleLimit)),
        completeCounts: !!scan.errorCounts,
      },
    );
  // 每条日志最多 8 个上下文字段，环境与结果分开记录，避免清理器截断。
  logEvent(
    "info",
    "library",
    "scan_diagnostics",
    "扫描运行信息；探测样本耗时包含等待名额及清理子进程。",
    {
      taskId: scan.id,
      ...(scan.elapsedMs !== undefined ? { elapsedMs: scan.elapsedMs } : {}),
      concurrency: scan.concurrency,
      peakProbes: scan.peakProbes,
      ...(scan.probeTimeoutMs !== undefined ? { probeTimeoutMs: scan.probeTimeoutMs } : {}),
      ...(scan.probeTimeouts !== undefined ? { probeTimeouts: scan.probeTimeouts } : {}),
      storageKind: scan.storageKind ?? "unknown",
      warnings: scan.warnings,
    },
  );
}

export function observeLibraryScan(service: {
  getSnapshot(): { scan: ScanProgress | null; directories?: { id: string; path: string }[] };
  subscribe(listener: () => void): () => void;
}) {
  let previous = service.getSnapshot().scan;
  return service.subscribe(() => {
    const scan = service.getSnapshot().scan;
    const changed = scan && (scan.id !== previous?.id || scan.state !== previous?.state);
    previous = scan;
    if (!changed || !scan || scan.state === "idle") return;
    const reproduction = {
      action: "scan",
      filePath: service.getSnapshot().directories?.find((item) => item.id === scan.directoryId)
        ?.path,
    };
    if (scan.state === "scanning") {
      logEvent(
        "info",
        "library",
        "scan_started",
        "目录扫描开始，计数包含视频与 NFO。",
        {
          taskId: scan.id,
          concurrency: scan.concurrency,
          ...(scan.probeTimeoutMs !== undefined ? { probeTimeoutMs: scan.probeTimeoutMs } : {}),
        },
        reproduction,
      );
      return;
    }
    recordDiagnostics(scan);
    const label = {
      completed: "扫描完成",
      partial: "扫描部分完成",
      failed: "扫描失败",
      cancelled: "扫描已取消",
      interrupted: "扫描已中断",
    }[scan.state];
    logEvent(
      scan.state === "failed" ? "error" : scan.state === "partial" ? "warn" : "info",
      "library",
      `scan_${scan.state}`,
      `${label}：已处理 ${scan.processed} / ${scan.discovered} 项（视频与 NFO），新增或更新 ${scan.imported}，未变化 ${scan.unchanged}，跳过 ${scan.skipped}，异常 ${scan.errors}。已保存的结果与原有资料保留；异常数可能包含目录级错误。`,
      {
        taskId: scan.id,
        state: scan.state,
        discovered: scan.discovered,
        processed: scan.processed,
        imported: scan.imported,
        unchanged: scan.unchanged,
        skipped: scan.skipped,
        errors: scan.errors,
      },
      reproduction,
    );
  });
}
