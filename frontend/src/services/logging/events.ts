export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogInput {
  level: LogLevel;
  module: string;
  event: string;
  message: string;
  context?: Record<string, string | number | boolean>;
}
export interface LogEntry extends LogInput {
  time: string;
  session: string;
  sequence: number;
}

// 不接收请求体、设置对象或进程参数。文本仍统一脱敏，以覆盖异常中的地址和凭据。
export function redactText(value: string, limit = 2000) {
  const cleaned = value
    .slice(0, 16000)
    // oxlint-disable-next-line no-control-regex -- 删除工具输出中的 ANSI 控制序列。
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:https?|socks5h?):\/\/[^\s<>"']+/gi, "[地址已隐藏]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, "[凭据已隐藏]")
    .replace(
      /((?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi,
      "$1[已隐藏]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)["']?\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi,
      "$1[已隐藏]",
    )
    // oxlint-disable-next-line no-control-regex -- 保留换行和制表符，清理其他控制字符。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const end = /[\ud800-\udbff]/.test(cleaned[limit - 1] ?? "") ? limit - 1 : limit;
  return cleaned.length > end ? `${cleaned.slice(0, end)}…` : cleaned;
}
export function cleanLog(input: LogInput): LogInput {
  const context: NonNullable<LogInput["context"]> = {};
  for (const [key, value] of Object.entries(input.context ?? {}).slice(0, 8)) {
    if (/token|password|secret|key|cookie|authorization|headers|body|prompt/i.test(key)) continue;
    if (typeof value === "string") context[key.slice(0, 40)] = redactText(value, 160);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      context[key.slice(0, 40)] = value;
  }
  return {
    level: ["debug", "info", "warn", "error"].includes(input.level) ? input.level : "error",
    module: redactText(String(input.module), 40),
    event: redactText(String(input.event), 60),
    message: redactText(String(input.message)),
    ...(Object.keys(context).length ? { context } : {}),
  };
}

let sink: ((input: LogInput) => void) | undefined;
let flush: (() => Promise<void>) | undefined;
let healthy: (() => boolean) | undefined;
export function setLogSink(
  write?: (input: LogInput) => void,
  drain?: () => Promise<void>,
  check?: () => boolean,
) {
  sink = write;
  flush = drain;
  healthy = check;
}
export function logEvent(
  level: LogLevel,
  module: string,
  event: string,
  message: string,
  context?: LogInput["context"],
) {
  try {
    sink?.(cleanLog({ level, module, event, message, context }));
  } catch {
    /* 诊断不能中断业务。 */
  }
}
export async function flushLogs() {
  // 文件系统故障不能使退出无限等待；超时返回 false，迁移调用方据此保留旧副本。
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!flush) return false;
  try {
    return await Promise.race([
      flush().then(() => healthy?.() ?? true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
export function captureUnhandledErrors() {
  const error = (event: ErrorEvent) =>
    logEvent(
      "error",
      "frontend",
      "uncaught",
      event.error instanceof Error ? (event.error.stack ?? event.message) : event.message,
    );
  const rejection = (event: PromiseRejectionEvent) =>
    logEvent(
      "error",
      "frontend",
      "unhandled_rejection",
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason),
    );
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
}
