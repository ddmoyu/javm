export type ResolutionProvider =
  | "direct-hls"
  | "static-page"
  | "json-config"
  | "packed-script"
  | "webview";
export interface ResolutionRequest {
  url: string;
  provider: ResolutionProvider;
  /** 第一阶段只接受调用方明确提供的上下文，不导入浏览器 Cookie。 */
  headers?: Record<string, string>;
  /** 仅 Referer/Origin/User-Agent 可随 HLS 的跨域子资源发送。 */
  publicHeaders?: Record<string, string>;
  preferProxy?: boolean;
  failRule?: { selector: string; text: string };
}
export type ResolutionFailure =
  | "invalid_input"
  | "not_found"
  | "parse_failed"
  | "network_error"
  | "rate_limited"
  | "interaction_required"
  | "session_required"
  | "unsupported_stream"
  | "limit_exceeded"
  | "timeout"
  | "cancelled"
  | "cleanup_failed"
  | "unavailable";
export type ResolutionState =
  | "queued"
  | "http"
  | "webview"
  | "validating"
  | "closing"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface ResolvedTrack {
  kind: "video" | "audio";
  url: string;
  duration: number;
  bandwidth?: number;
  width?: number;
  height?: number;
}
export interface ResolvedStream {
  pageUrl: string;
  manifestUrl: string;
  tracks: ResolvedTrack[];
  discoveredBy: "http" | "webview";
  validation: "playlist-and-sample";
  checkedAt: number;
  expiresAt: number;
  /** 仅对该 origin 有效，不能直接作为下载器的跨域全局请求头。 */
  context: {
    origin: string;
    headers: Record<string, string>;
    publicHeaders?: Record<string, string>;
    preferProxy?: boolean;
  };
}
export type ResolutionOutcome =
  | { ok: true; streams: ResolvedStream[] }
  | { ok: false; code: ResolutionFailure; message: string; fallbackEligible: boolean };
/** 订阅快照不包含网页内容、URL、请求头或候选，敏感结果只交给提交者。 */
export interface ResolutionTask {
  id: string;
  provider: ResolutionProvider;
  state: ResolutionState;
  requests: number;
  found: number;
  error?: Exclude<ResolutionOutcome, { ok: true }>;
}
export interface ResolutionHandle {
  id: string;
  result: Promise<ResolutionOutcome>;
  cancel(): void;
}
