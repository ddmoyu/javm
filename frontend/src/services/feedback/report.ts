import { cleanLog, redactText } from "../logging/events";
import type { LogEntry } from "../logging/events";
import type { FailureInput } from "./events";
import { cleanMetadataDiagnostics } from "../metadata/diagnostics";
import { diagnosticUrl } from "../logging/sanitize";
import { reproductionText } from "../logging/reproduction";

export const feedbackPolicy = { reports: 8, days: 7, before: 14000, after: 4000, followMs: 3000 };
export const issuesUrl = "https://github.com/ddmoyu/javm/issues/new";
export type SystemDetails = Record<string, string>;
export interface FailureReport extends FailureInput {
  id: string;
  session: string;
  time: string;
  count: number;
  system: SystemDetails;
  before: string;
  after: string;
  complete: boolean;
}

export function diagnosticText(value: string, limit = 4000) {
  return redactText(value, limit);
}

export const feedbackUrl = diagnosticUrl;

export function logLine(entry: LogEntry) {
  const clean = cleanLog(entry);
  return diagnosticText(
    `${entry.time} ${clean.level.toUpperCase()} ${clean.module}/${clean.event} ${clean.message}${clean.context ? ` ${JSON.stringify(clean.context)}` : ""}${clean.reproduction ? ` ${JSON.stringify(clean.reproduction)}` : ""}`,
    10000,
  );
}
export function relatedLog(entry: LogEntry, taskId?: string, queryId?: string) {
  if (taskId && entry.context?.taskId && entry.context.taskId !== taskId) return false;
  if (taskId && entry.context?.queryId && !entry.context.taskId) return false;
  if (queryId && entry.context?.queryId && entry.context.queryId !== queryId) return false;
  // 旧组件 stdout 和没有关联 ID 的 HTTP 摘录不能归因给本次查询。
  if (
    (taskId || queryId) &&
    !entry.context?.queryId &&
    ((entry.module === "metatube" && ["engine", "legacy_engine"].includes(entry.event)) ||
      (entry.module === "network" && entry.context?.purpose === "metadata"))
  )
    return false;
  return true;
}
export function logExcerpt(
  entries: LogEntry[],
  taskId?: string,
  limit = feedbackPolicy.before,
  queryId?: string,
) {
  const lines: string[] = [];
  let length = 0;
  for (const entry of entries.slice().reverse()) {
    if (!relatedLog(entry, taskId, queryId)) continue;
    const line = logLine(entry);
    if (length + line.length + 1 > limit) break;
    lines.push(line);
    length += line.length + 1;
    if (lines.length === 100) break;
  }
  return lines.reverse().join("\n");
}

const titles: Record<string, string> = {
  downloads: "下载失败",
  library: "媒体库或扫描失败",
  database: "数据库操作失败",
  scraping: "刮削失败",
  playback: "播放失败",
  settings: "设置保存或读取失败",
  updates: "软件更新失败",
  network: "网络操作失败",
  catalog: "在线资料操作失败",
  ai: "AI 操作失败",
  metatube: "资料服务失败",
  process: "后台组件失败",
  artwork: "封面处理失败",
  backup: "备份或恢复失败",
  frontend: "界面发生异常",
  app: "应用发生异常",
  resolution: "资源解析失败",
  magnets: "磁力搜索失败",
};
export function failureFromLog(entry: LogEntry): FailureInput | undefined {
  if (entry.module === "feedback" || entry.module === "logging") return;
  if (entry.module === "scraping" && entry.context?.reported === true) return;
  // 工具的一次错误仍可能被重试修复；只在下载任务最终失败时由服务显式报告。
  if (
    entry.module === "downloads" &&
    ["tool_output", "legacy_output", "state_changed"].includes(entry.event)
  )
    return;
  const terminalWarning =
    (entry.module === "library" && entry.event === "scan_partial") ||
    (entry.module === "scraping" && ["failed", "partial"].includes(entry.event)) ||
    (entry.module === "settings" && entry.event === "ui_preferences_failed");
  if (entry.level !== "error" && !terminalWarning) return;
  return {
    module: entry.module,
    title:
      entry.module === "library" && entry.event === "scan_partial"
        ? "扫描部分完成"
        : (titles[entry.module] ?? "操作失败"),
    message: entry.message,
    taskId: typeof entry.context?.taskId === "string" ? entry.context.taskId : undefined,
    details: entry.context,
    reproduction: entry.reproduction,
  };
}

const block = (text: string) => `\`\`\`text\n${text.replaceAll("```", "ˋˋˋ")}\n\`\`\``;
function metadataBlock(report: FailureReport) {
  const diagnostic = cleanMetadataDiagnostics(report.metadata);
  if (!diagnostic) return [];
  const counts: Record<string, number> = {};
  for (const item of diagnostic.sources)
    counts[item.category] = (counts[item.category] ?? 0) + item.count;
  return [
    "",
    "## 资料查询诊断",
    block(
      [
        `查询 ID: ${diagnostic.queryId}`,
        `阶段: ${diagnostic.operation}`,
        `MetaTube: ${diagnostic.version}`,
        `最后请求配置: ${diagnostic.network}；本次使用过: ${diagnostic.networks.join(", ") || "unknown"}（direct=应用直连；proxy/协议=应用代理；unknown=未取得）`,
        `请求次数: ${diagnostic.attempts}；总耗时: ${diagnostic.elapsedMs} ms`,
        `诊断完整性: ${diagnostic.detailed ? "组件提供了来源诊断" : "部分请求未提供来源诊断，不能据此断定无收录或代理未开启"}`,
        `来源统计（含重试）: ${JSON.stringify(counts)}`,
        ...(diagnostic.omitted ? [`超出限制或无效的来源记录: ${diagnostic.omitted}`] : []),
        "来源明细（相同结果合并，耗时累计，结果数为最后一次；skipped 为不支持编号格式）:",
        ...diagnostic.sources
          .filter((item) => item.category !== "skipped")
          .map(
            (item) =>
              `${item.provider}: ${item.category}；次数=${item.count}；耗时=${item.elapsedMs} ms；结果=${item.results ?? "未知"}${item.stage ? `；失败阶段=${item.stage}` : ""}${item.reason ? `；原因=${item.reason}` : ""}${item.httpStatus === undefined ? "" : `；HTTP=${item.httpStatus}`}${item.missingFields?.length ? `；缺少字段=${item.missingFields.join(",")}` : ""}`,
          ),
      ].join("\n"),
    ),
  ];
}
export function formatReport(report: FailureReport) {
  const context = Object.entries(report.details ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return [
    "## 问题描述",
    "请补充操作步骤、预期结果，以及是否可以重复出现。",
    "",
    "## 异常信息",
    block(
      `类型: ${report.title}\n时间: ${report.time}\n模块: ${report.module}\n报告 ID: ${report.id}\n会话 ID: ${report.session}\n重复次数: ${report.count}${report.taskId ? `\n任务 ID: ${report.taskId}` : ""}\n\n${report.message}${context ? `\n\n${context}` : ""}`,
    ),
    ...(report.reproduction
      ? ["", "## 复现信息", block(reproductionText(report.reproduction))]
      : []),
    ...metadataBlock(report),
    ...(report.url ? ["", "## 下载链接（完整地址）", block(report.url)] : []),
    "",
    "## 系统信息",
    block(
      Object.entries(report.system)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n") || "系统信息未能采集",
    ),
    "",
    "## 故障前日志（有长度上限）",
    block(report.before || "没有可用的故障前日志"),
    "",
    "## 故障后日志",
    block(
      report.after || (report.complete ? "没有后续日志；进程退出时无法补采" : "尚在收集收尾日志"),
    ),
    "",
    "番号、查询内容、文件名和业务链接保留；常见凭据与本机用户名已隐藏。链接保留查询参数及可能存在的临时签名，提交前请检查预览。",
  ].join("\n");
}
