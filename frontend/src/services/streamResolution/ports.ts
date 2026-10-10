import type { ResolutionProvider, ResolutionRequest } from "../../contracts/streamResolution";

export interface StreamCandidate {
  url: string;
  publicHeaders: Record<string, string>;
}
/** 返回前必须确认浏览器及其子进程全部退出。 */
export type ResolutionWebviewPort = (
  request: ResolutionRequest,
  signal: AbortSignal,
  proxy: string,
) => Promise<StreamCandidate[]>;

export interface ByteRange {
  start: number;
  length: number;
}
export interface ResolutionHttpRequest {
  url: string;
  headers: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  proxy: string;
  range?: ByteRange;
}
/** 一次请求，不自动重定向、不重试；返回的 body 已有硬大小上限。 */
export type ResolutionHttpPort = (
  request: ResolutionHttpRequest,
  signal: AbortSignal,
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}>;
export interface PageResult {
  candidates: string[];
  next: { url: string; provider: ResolutionProvider }[];
}
export interface Segment {
  url: string;
  range?: ByteRange;
  key?: string;
  map?: { url: string; range?: ByteRange; key?: string };
}
export interface Variant {
  url: string;
  bandwidth: number;
  width?: number;
  height?: number;
  audio?: string;
}
export type Playlist =
  | {
      kind: "master";
      variants: Variant[];
      audio: { group: string; url?: string; preferred: boolean }[];
    }
  | { kind: "media"; duration: number; first: Segment };
export interface ParseTasks {
  page: {
    input: { url: string; provider: ResolutionProvider; body: ArrayBuffer };
    output: PageResult;
  };
  playlist: { input: { url: string; body: ArrayBuffer }; output: Playlist };
}
export interface ResolutionParser {
  run<K extends keyof ParseTasks>(
    operation: K,
    input: ParseTasks[K]["input"],
    signal: AbortSignal,
  ): Promise<ParseTasks[K]["output"]>;
  close(): void;
}
