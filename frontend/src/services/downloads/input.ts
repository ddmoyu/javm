import type { DownloadSettings, DownloadTask, NewDownload } from "../../contracts/downloads";
import { defaultDownloadSettings, downloadTaskLimit } from "../../contracts/downloads";
import { keepTextTail } from "./text";
import { identifyCode, normalizeCode } from "../scraping/identity";
import { downloadCode, duplicateDownloadCodes, DuplicateDownloadError } from "./duplicates";
import { windowsPath } from "../paths";
import { redactText } from "../logging/sanitize";

export function normalizeDownloadUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入有效的 HTTP 或 HTTPS 视频直链，每行一条。");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("仅支持 HTTP / HTTPS 视频直链；磁力链接请交给外部下载器。");
  }
  url.hash = "";
  return url.href;
}

// Control characters are deliberately rejected in names, paths and HTTP headers.
/* oxlint-disable no-control-regex */
export function safeName(value: string) {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  const name = cleaned || "video";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

export function joinPath(root: string, ...parts: string[]) {
  return `${root.replace(windowsPath(root) ? /[\\/]+$/ : /\/+$/, "")}/${parts.join("/")}`;
}

export function validateDirectory(value: string) {
  const path = value.trim();
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(path) || /[\u0000-\u001f]/.test(path)) {
    throw new Error("请选择或输入绝对保存目录。");
  }
  return path;
}

export function parseHeaders(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/).filter((part) => part.trim())) {
    const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*(.*)$/.exec(line);
    if (!match || /[\u0000-\u001f\u007f]/.test(match[2]!)) {
      throw new Error("请求头格式应为 名称: 值，每行一条。");
    }
    const name = match[1]!;
    if (/^(host|range|if-range|content-length|transfer-encoding|connection)$/i.test(name)) {
      throw new Error(`${name} 由下载器管理，请移除此请求头。`);
    }
    if (Object.keys(result).some((key) => key.toLowerCase() === name.toLowerCase())) {
      throw new Error(`请求头 ${name} 重复。`);
    }
    result[name] = match[2]!;
  }
  return result;
}

export function readDownloadSettings(value: unknown): DownloadSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("下载设置格式无效，原配置已保留。");
  const data = value as Record<string, unknown>;
  const settings = { ...defaultDownloadSettings };
  for (const field of ["directory", "ffmpegPath", "curlPath"] as const) {
    if (data[field] === undefined) continue;
    if (typeof data[field] !== "string") throw new Error("下载设置中的路径格式无效。");
    settings[field] = data[field];
  }
  if (data.concurrency !== undefined) {
    if (typeof data.concurrency !== "number") throw new Error("下载设置中的并发数格式无效。");
    settings.concurrency = data.concurrency;
  }
  // 未指定目录的旧配置继续由下载引擎解析系统默认目录；只保留现行字段。
  return validateSettings(settings, true);
}

export function validateSettings(settings: DownloadSettings, allowDefaultDirectory = false) {
  if (!allowDefaultDirectory || settings.directory !== "") validateDirectory(settings.directory);
  if (
    [settings.ffmpegPath, settings.curlPath].some((value) => /[\u0000-\u001f\u007f]/.test(value))
  ) {
    throw new Error("工具路径不能包含换行或控制字符。");
  }
  if (
    !Number.isInteger(settings.concurrency) ||
    settings.concurrency < 1 ||
    settings.concurrency > 5
  ) {
    throw new Error("同时下载数应为 1 到 5。");
  }
  return settings;
}

export function createDownloadTasks(
  input: NewDownload,
  existing: DownloadTask[],
  confirmedCodes: string[] = [],
): DownloadTask[] {
  if (input.workId !== undefined && !/^[a-f0-9-]{36}$/i.test(input.workId))
    throw new Error("关联作品标识无效，请重新打开作品。");
  const directory = validateDirectory(input.directory);
  const urls = [...new Set(input.urls.map(normalizeDownloadUrl))];
  if (!urls.length || urls.length > 100) throw new Error("每次请输入 1 到 100 条视频直链。");
  if (existing.length + urls.length > downloadTaskLimit)
    throw new Error(`最多保留 ${downloadTaskLimit} 个下载任务，请先移除已结束的任务。`);
  // Validate callers outside the form as well.
  if (
    Object.entries(input.headers).some(([key, value]) => /[\u0000-\u001f\u007f]/.test(key + value))
  ) {
    throw new Error("请求头不能包含换行或控制字符。");
  }
  const headers = parseHeaders(
    Object.entries(input.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  const tasks: DownloadTask[] = urls.map((url, index) => {
    const id = crypto.randomUUID();
    let leaf = new URL(url).pathname.split("/").pop() || "video";
    try {
      leaf = decodeURIComponent(leaf);
    } catch {
      /* Keep malformed escapes as text. */
    }
    const name = safeName(
      input.name?.trim()
        ? `${input.name}${urls.length > 1 ? `-${index + 1}` : ""}`
        : leaf.replace(/\.(m3u8|mp4|mkv|ts)$/i, ""),
    );
    const taskDirectory = joinPath(directory, `${name}-${id.slice(0, 8)}`);
    const now = new Date().toISOString();
    return {
      id,
      revision: 0,
      name,
      url,
      kind:
        input.kind === "auto"
          ? /\.m3u8$/i.test(new URL(url).pathname)
            ? "hls"
            : "http"
          : input.kind,
      headers,
      directory: taskDirectory,
      output: joinPath(taskDirectory, `${name}.mp4`),
      workDirectory: joinPath(taskDirectory, ".javm-download"),
      status: "queued",
      phase: "download",
      inputs: [],
      progress: null,
      downloaded: 0,
      total: 0,
      speed: 0,
      error: "",
      log: [],
      createdAt: now,
      updatedAt: now,
      scrapeAfterDownload: true,
      workId: input.workId,
      code: input.code?.trim() || identifyCode(name),
    };
  });
  const confirmed = new Set(confirmedCodes.map(normalizeCode));
  const duplicates = duplicateDownloadCodes(tasks, existing).filter(
    (code) => !confirmed.has(normalizeCode(code)),
  );
  if (duplicates.length) throw new DuplicateDownloadError(duplicates, tasks.length);
  if (
    tasks.some((task) => {
      const code = downloadCode(task);
      return (
        (!code || !confirmed.has(normalizeCode(code))) &&
        existing.some(
          (item) =>
            item.url === task.url && item.status !== "completed" && item.status !== "cancelled",
        )
      );
    })
  ) {
    throw new Error("列表中已有相同链接的未完成任务，请继续或重试原任务。");
  }
  return tasks;
}

export function redactLog(line: string, task: Pick<DownloadTask, "url" | "headers">) {
  let result = line;
  for (const [name, value] of Object.entries(task.headers)) {
    if (value && !/^(referer|origin)$/i.test(name))
      result = result.replaceAll(value, "[请求头已隐藏]");
  }
  return keepTextTail(redactText(result, 16000), 1500);
}
