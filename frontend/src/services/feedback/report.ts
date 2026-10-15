import { cleanLog, redactText } from "../logging/events";
import type { LogEntry } from "../logging/events";
import type { FailureInput } from "./events";

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
  return redactText(value, limit)
    .replace(/\b[A-Z]:[\\/]+Users[\\/]+[^\\/\r\n"'<>]+/gi, "C:/Users/[用户]")
    .replace(/\/(?:home|Users)\/[^/\r\n"'<>]+/g, "/home/[用户]");
}

// 用户明确要求报告保留完整下载链接；链接只放在独立字段，不进入普通日志。
export function feedbackUrl(value: string) {
  if (value.length > 8192) return "[链接超过 8192 字符，未包含]";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      ? value.replace(/[\r\n\t]/g, "")
      : "[不支持的链接类型]";
  } catch {
    return "[链接无效]";
  }
}

export function logLine(entry: LogEntry) {
  const clean = cleanLog(entry);
  return diagnosticText(
    `${entry.time} ${clean.level.toUpperCase()} ${clean.module}/${clean.event} ${clean.message}${clean.context ? ` ${JSON.stringify(clean.context)}` : ""}`,
    1800,
  );
}
export function relatedLog(entry: LogEntry, taskId?: string) {
  return !taskId || !entry.context?.taskId || entry.context.taskId === taskId;
}
export function logExcerpt(entries: LogEntry[], taskId?: string, limit = feedbackPolicy.before) {
  const lines: string[] = [];
  let length = 0;
  for (const entry of entries.slice().reverse()) {
    if (!relatedLog(entry, taskId)) continue;
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
  // 工具的一次错误仍可能被重试修复；只在下载任务最终失败时由服务显式报告。
  if (
    entry.module === "downloads" &&
    ["tool_output", "legacy_output", "state_changed"].includes(entry.event)
  )
    return;
  const terminalWarning =
    (entry.module === "scraping" && ["failed", "partial"].includes(entry.event)) ||
    (entry.module === "settings" && entry.event === "ui_preferences_failed");
  if (entry.level !== "error" && !terminalWarning) return;
  return {
    module: entry.module,
    title: titles[entry.module] ?? "操作失败",
    message: entry.message,
    taskId: typeof entry.context?.taskId === "string" ? entry.context.taskId : undefined,
    details: entry.context,
  };
}

const block = (text: string) => `\`\`\`text\n${text.replaceAll("```", "ˋˋˋ")}\n\`\`\``;
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
    "日志已隐藏常见凭据与本机用户名；下载链接按用户选择保留完整地址。",
  ].join("\n");
}
