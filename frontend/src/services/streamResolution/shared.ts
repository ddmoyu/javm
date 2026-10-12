import type {
  ResolutionFailure,
  ResolutionOutcome,
  ResolutionRequest,
} from "../../contracts/streamResolution";

const messages: Record<ResolutionFailure, string> = {
  invalid_input: "取流输入无效。",
  not_found: "未找到资源。",
  parse_failed: "未获取到有效的 HLS 资源。",
  network_error: "资源请求失败。",
  rate_limited: "请求过于频繁。",
  interaction_required: "页面需要人工操作，已结束获取。",
  session_required: "资源需要当前传输无法复现的会话。",
  unsupported_stream: "暂不支持此流格式或直播。",
  limit_exceeded: "取流超过大小、数量或排队限制。",
  timeout: "取流超时。",
  cancelled: "已取消获取。",
  cleanup_failed: "未能确认取流操作已清理，请重试清理或退出应用。",
  unavailable: "当前环境无法使用取流服务。",
};
export class ResolutionError extends Error {
  constructor(
    readonly code: ResolutionFailure,
    readonly fallbackEligible = false,
  ) {
    super(messages[code]);
    this.name = "ResolutionError";
  }
}
export function failure(error: unknown): Exclude<ResolutionOutcome, { ok: true }> {
  const safe = error instanceof ResolutionError ? error : new ResolutionError("network_error");
  return {
    ok: false,
    code: safe.code,
    message: safe.message,
    fallbackEligible: safe.fallbackEligible,
  };
}
export const bounds = {
  pageBytes: 2 * 1024 * 1024,
  playlistBytes: 1024 * 1024,
  candidates: 16,
  requests: 32,
  redirects: 3,
  queue: 32,
  active: 10,
  // 隐藏取流实例并行上限：按逻辑处理器留出余量，最少 2 个，最多 8 个。
  webviews: Math.max(
    2,
    Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2),
  ),
  perSource: 2,
  queueMs: 120_000,
  httpMs: 30_000,
  webviewMs: 20_000,
  requestMs: 10_000,
  // 低于该时长的点播视为预告或广告，不作为影片资源。
  featureSeconds: 600,
};
export function webUrl(raw: string, base?: string) {
  try {
    // oxlint-disable-next-line no-control-regex -- URL 禁止换行与其他控制字符。
    if (raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error();
    const url = new URL(raw, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
    url.hash = "";
    return url.href;
  } catch {
    throw new ResolutionError("invalid_input");
  }
}
export function normalizeRequest(input: ResolutionRequest): ResolutionRequest {
  if (
    !["direct-hls", "static-page", "json-config", "packed-script", "webview"].includes(
      input.provider,
    )
  )
    throw new ResolutionError("invalid_input");
  const headers: Record<string, string> = {};
  let size = 0;
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const name = key.toLowerCase();
    size += name.length + value.length;
    if (size > 16_384 || Object.keys(headers).length >= 32)
      throw new ResolutionError("limit_exceeded");
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      // oxlint-disable-next-line no-control-regex -- 阻止请求头换行注入。
      /[\u0000-\u001f\u007f]/.test(value) ||
      /^(host|range|content-length|transfer-encoding|connection|accept-encoding)$/.test(name) ||
      name in headers
    )
      throw new ResolutionError("invalid_input");
    headers[name] = value;
  }
  if (size > 16_384 || Object.keys(headers).length > 32)
    throw new ResolutionError("limit_exceeded");
  const publicHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.publicHeaders ?? {})) {
    const name = key.toLowerCase();
    if (
      !/^(referer|origin|user-agent)$/.test(name) ||
      value.length > 8192 ||
      // oxlint-disable-next-line no-control-regex -- 只接受有界、无控制字符的公开浏览器上下文。
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new ResolutionError("invalid_input");
    publicHeaders[name] = value;
  }
  return { ...input, url: webUrl(input.url), headers, publicHeaders };
}
export function check(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason instanceof ResolutionError
      ? signal.reason
      : new ResolutionError("cancelled");
}
