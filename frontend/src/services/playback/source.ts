import { windowsPath } from "../paths";
import type { ReproductionContext } from "../logging/reproduction";
export type PlaybackFormat = "video" | "hls";
export interface PlaybackOptions {
  title?: string;
  /** 无扩展名且服务器未声明类型时，调用方可明确指定 HLS。 */
  format?: PlaybackFormat;
  referer?: string;
}
export interface PlaybackRequest extends PlaybackOptions {
  source: string;
  kind: "local" | "network";
  title: string;
  format?: PlaybackFormat;
}

export function playbackReproduction(request?: PlaybackRequest): ReproductionContext | undefined {
  if (!request) return;
  return {
    action: "playback",
    pageUrl: request.referer,
    ...(request.kind === "network" ? { mediaUrl: request.source } : { filePath: request.source }),
  };
}

const mediaExtension = /\.(mp4|m4v|webm|mov|mkv|avi|wmv|mpg|mpeg|ts|m2ts|mts|m3u8|ogv|3gp|flv)$/i;

export function playbackRequest(source: string, options: PlaybackOptions = {}): PlaybackRequest {
  source = source.trim();
  if (!source || Array.from(source).some((char) => char.charCodeAt(0) < 32))
    throw new Error("视频地址为空或包含无效字符。");
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.username || url.password) throw new Error("视频链接不能包含用户名或密码。");
    const title = options.title?.trim() || decodeName(url.pathname.split("/").at(-1) || "网络视频");
    const format =
      options.format ??
      (/\.m3u8$/i.test(url.pathname)
        ? "hls"
        : mediaExtension.test(url.pathname)
          ? "video"
          : undefined);
    if (options.referer && !/^https?:\/\//i.test(options.referer))
      throw new Error("来源页面必须是 HTTP 或 HTTPS 地址。");
    if (options.referer && /[\r\n\0]/.test(options.referer)) throw new Error("来源页面地址无效。");
    return { ...options, source: url.href, kind: "network", title, format };
  }
  if (/^file:\/\//i.test(source)) {
    const url = new URL(source);
    source = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") source = `//${url.hostname}${source}`;
    else if (/^\/[a-z]:\//i.test(source)) source = source.slice(1);
  }
  if (windowsPath(source)) source = source.replaceAll("\\", "/");
  if (Array.from(source).some((char) => char.charCodeAt(0) < 32))
    throw new Error("视频路径包含无效字符。");
  if (
    !/^(?:[a-z]:\/|\/)/i.test(source) ||
    source.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("请传入本地视频的完整路径或 HTTP／HTTPS 视频直链。");
  if (!mediaExtension.test(source)) throw new Error("这不是支持的视频文件类型。");
  return {
    ...options,
    source,
    kind: "local",
    title: options.title?.trim() || source.split("/").at(-1) || "本地视频",
    format: options.format ?? (/\.m3u8$/i.test(source) ? "hls" : "video"),
  };
}

/** 输入已由 playbackRequest 规范化；标题、格式提示和 Referer 不改变视频身份。 */
export function playbackSourceKey(request: PlaybackRequest) {
  const source =
    request.kind === "local" && /^(?:[a-z]:|\/\/)/i.test(request.source)
      ? request.source.toLowerCase()
      : request.source;
  return `${request.kind}:${source}`;
}

function decodeName(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localMediaLocation(path: string) {
  const normalized = playbackRequest(path).source;
  const index = normalized.lastIndexOf("/");
  const directory = normalized.slice(0, index) || "/";
  return { directory, fileName: normalized.slice(index + 1) };
}

export function canMountMediaDirectory(directory: string) {
  return directory !== "/" && !/^[a-z]:$/i.test(directory) && !/^\/\/[^/]+\/[^/]+$/.test(directory);
}

export function responseFormat(contentType: string | null): PlaybackFormat | undefined {
  if (contentType && /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(contentType)) return "hls";
  if (contentType && /^video\//i.test(contentType)) return "video";
  return undefined;
}
