import { redactText } from "./sanitize";
import { cleanReproduction } from "./reproduction";
import type { ReproductionContext } from "./reproduction";
export { redactText } from "./sanitize";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogInput {
  level: LogLevel;
  module: string;
  event: string;
  message: string;
  context?: Record<string, string | number | boolean>;
  reproduction?: ReproductionContext;
}
export interface LogEntry extends LogInput {
  time: string;
  session: string;
  sequence: number;
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
    ...(input.reproduction ? { reproduction: cleanReproduction(input.reproduction) } : {}),
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
  reproduction?: ReproductionContext,
) {
  try {
    sink?.(cleanLog({ level, module, event, message, context, reproduction }));
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
