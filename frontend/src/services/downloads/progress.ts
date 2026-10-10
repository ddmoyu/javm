import type { DownloadProgress } from "./ports";
import type { DownloadTask } from "../../contracts/downloads";
import { keepTextTail } from "./text";

// Terminal progress uses literal ESC sequences.
// oxlint-disable-next-line no-control-regex
const ansiEscape = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const hlsBytes = String.raw`[\d.]+\s*[KMGT]?i?B`;
const hlsStats = new RegExp(
  String.raw`(\d+)/(\d+)\s+([\d.]+)%\s*(?:(${hlsBytes})(?:\s*/\s*(${hlsBytes}))?|-)\s*(?:(${hlsBytes}(?:ps|/s))|-)(?:\(\d+\))?`,
  "i",
);
const hlsRow = new RegExp(
  String.raw`(?:Vid|Aud|Sub)\b(?:(?!(?:Vid|Aud|Sub)\b)[^\r\n])*?${hlsStats.source}\s*(?:\d{2,}:\d{2}:\d{2}|--:--:--)`,
  "gi",
);

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

// Redirected N_m3u8DL-RE output concatenates table rows without newlines.
// Wait for a complete row (including ETA), keeping split chunks for the next event.
export class HlsOutput {
  private pending = "";
  push(chunk: string): string[] {
    this.pending = (this.pending + chunk).replace(ansiEscape, "");
    const lines: string[] = [];
    let end = 0;
    for (const match of this.pending.matchAll(hlsRow)) {
      lines.push(...this.pending.slice(end, match.index).split(/[\r\n]+/), match[0]);
      end = match.index! + match[0].length;
    }
    this.pending = this.pending.slice(end);
    const newline = Math.max(this.pending.lastIndexOf("\r"), this.pending.lastIndexOf("\n"));
    if (newline >= 0) {
      lines.push(...this.pending.slice(0, newline + 1).split(/[\r\n]+/));
      this.pending = this.pending.slice(newline + 1);
    }
    this.pending = keepTextTail(this.pending, 8192);
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

export function parseHlsProgress(line: string): DownloadProgress | undefined {
  const match = hlsStats.exec(stripAnsi(line));
  if (!match) return undefined;
  const done = Number(match[1]);
  const count = Number(match[2]);
  const percent = Number(match[3]);
  const downloaded = byteValue(match[4] ?? "0");
  const reportedTotal = byteValue(match[5] ?? "0");
  const speed = byteValue(match[6] ?? "0");
  if (
    !Number.isSafeInteger(done) ||
    !Number.isSafeInteger(count) ||
    count <= 0 ||
    done > count ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    ![downloaded, reportedTotal, speed].every(Number.isFinite)
  )
    return undefined;
  // Rounded "100.00%" alone does not establish that every segment is complete.
  const complete = done === count && percent === 100;
  return {
    progress: complete ? 100 : Math.min(99.99, percent),
    downloaded,
    total: complete ? downloaded : reportedTotal,
    totalIsEstimate: !complete,
    speed,
  };
}

// N_m3u8DL-RE prints separate progress rows for video and audio. Keep each
// stream's latest row so one stream does not overwrite the whole task's size.
export class HlsProgress {
  private streams = new Map<string, DownloadProgress>();
  push(line: string): DownloadProgress | undefined {
    const update = parseHlsProgress(line);
    if (!update) return undefined;
    const key = stripAnsi(line)
      .split(/\d+\/\d+\s+[\d.]+%/)[0]!
      .replace(/[\s\-─━╸╺]+$/u, "")
      .replace(/\s+/g, " ");
    this.streams.set(key, update);
    const streams = [...this.streams.values()];
    const downloaded = streams.reduce((sum, stream) => sum + (stream.downloaded || 0), 0);
    const known = streams.every((stream) => (stream.total || 0) > 0);
    const total = known ? streams.reduce((sum, stream) => sum + stream.total!, 0) : 0;
    const complete = streams.every((stream) => stream.progress === 100);
    // A queued audio track has no size yet. Its unknown size must not erase
    // the video track's known progress; use equal track weights until all sizes arrive.
    const progress = total
      ? (downloaded / total) * 100
      : streams.reduce((sum, stream) => sum + (stream.progress || 0), 0) / streams.length;
    return {
      downloaded,
      total,
      totalIsEstimate: streams.some((stream) => stream.totalIsEstimate),
      progress: Math.min(complete ? 100 : 99.99, progress),
      speed: streams.reduce((sum, stream) => sum + (stream.speed || 0), 0),
    };
  }
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
