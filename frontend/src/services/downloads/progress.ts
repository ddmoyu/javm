import type { DownloadProgress } from "./ports";
import type { DownloadTask } from "../../contracts/downloads";
import { keepTextTail } from "./text";

// Terminal progress uses literal ESC sequences.
// oxlint-disable-next-line no-control-regex
const ansiEscape = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export class OutputLines {
  private pending = "";
  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split(/[\r\n]+/);
    this.pending = keepTextTail(lines.pop() ?? "", 8192);
    return lines.map(stripAnsi).filter(Boolean);
  }
  finish() {
    const tail = stripAnsi(this.pending);
    this.pending = "";
    return tail ? [tail] : [];
  }
}

export function stripAnsi(value: string) {
  return value.replace(ansiEscape, "").trim();
}

export function byteValue(value: string) {
  const match = /^([\d.]+)\s*([KMGT]?)(?:I?B)?(?:PS|\/S)?$/i.exec(value);
  return match
    ? Number(match[1]) * 1024 ** (match[2] ? "KMGT".indexOf(match[2].toUpperCase()) + 1 : 0)
    : 0;
}

export function parseCurlProgress(line: string): DownloadProgress | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 12 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[2]!)) return undefined;
  const total = byteValue(parts[1]!);
  return {
    progress: total ? Math.min(100, Number(parts[2])) : null,
    total,
    totalIsEstimate: false,
    downloaded: byteValue(parts[3]!),
    speed: byteValue(parts[11]!),
  };
}

/** 剩余时间：不足 1 分钟显示秒，不足 1 小时显示分和秒，更长显示小时和分。 */
export function formatRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.ceil(seconds);
  if (total < 60) return `约 ${total} 秒`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60),
      rest = total % 60;
    return rest ? `约 ${minutes} 分 ${rest} 秒` : `约 ${minutes} 分钟`;
  }
  const hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60);
  return minutes ? `约 ${hours} 小时 ${minutes} 分` : `约 ${hours} 小时`;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const power = Math.max(0, Math.min(4, Math.floor(Math.log(value) / Math.log(1024))));
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][power]}`;
}

export function formatDownloadSize(
  task: Pick<DownloadTask, "status" | "outputSize" | "total" | "downloaded" | "totalIsEstimate">,
) {
  if (task.status === "completed")
    return task.outputSize ? formatBytes(task.outputSize) : "大小未知";
  if (task.total > 0)
    return `${formatBytes(task.downloaded)} / ${task.totalIsEstimate ? "约 " : ""}${formatBytes(task.total)}`;
  return task.downloaded > 0 ? `${formatBytes(task.downloaded)} / 总大小未知` : "大小未知";
}
