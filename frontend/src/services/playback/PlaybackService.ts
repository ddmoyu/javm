import { playbackRequest } from "./source";
import type { PlaybackOptions, PlaybackRequest, PlaybackFormat } from "./source";
import type { PlaybackProgress } from "./PlaybackHistory";
import { logEvent } from "../logging/events";

export interface MediaResponse {
  url: string;
  data: ArrayBuffer;
  contentType?: string;
}
export type NativeMediaFetch = (
  url: string,
  signal: AbortSignal,
  range?: { start: number; end?: number },
) => Promise<MediaResponse>;
export interface PreparedPlayback {
  request: PlaybackRequest;
  url: string;
  format: PlaybackFormat;
  nativeFetch?: NativeMediaFetch;
  progress?: PlaybackProgress;
  dispose: () => Promise<void>;
}
export interface PlaybackPort {
  prepare: (request: PlaybackRequest, signal: AbortSignal) => Promise<PreparedPlayback>;
}
export interface PlaybackSnapshot {
  opened: boolean;
  preparing: boolean;
  request?: PlaybackRequest;
  media?: PreparedPlayback;
  error?: string;
  revision: number;
}

/** 业务调用方不依赖视频在当前页面还是独立窗口内渲染。 */
export type PlaybackController = Pick<
  PlaybackService,
  "getSnapshot" | "subscribe" | "close" | "shutdown"
> & {
  play(source: string, options?: PlaybackOptions): Promise<{ started: boolean } | void>;
};

/** 单个应用级播放会话；页面切换和 React StrictMode 不会创建第二个播放服务。 */
export class PlaybackService {
  private snapshot: PlaybackSnapshot = { opened: false, preparing: false, revision: 0 };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private operation?: Promise<void>;
  private resources = new Set<PreparedPlayback>();
  private closing?: Promise<void>;
  private stopped = false;
  constructor(private port: PlaybackPort) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: PlaybackSnapshot) {
    if (value.error && value.error !== this.snapshot.error)
      logEvent("error", "playback", "failed", value.error);
    if (value.opened !== this.snapshot.opened || value.preparing !== this.snapshot.preparing)
      logEvent(
        "info",
        "playback",
        "state_changed",
        value.preparing ? "正在准备播放" : value.opened ? "播放源已就绪" : "播放已关闭",
        { revision: value.revision },
      );
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }
  private async release(media: PreparedPlayback) {
    await media.dispose();
    this.resources.delete(media);
  }
  private async releaseAll() {
    // 失败的清理保留引用，下次关闭、切换或退出时可以重试。
    for (const media of this.resources) await this.release(media);
  }
  async play(source: string, options: PlaybackOptions = {}) {
    if (this.stopped) throw new Error("应用正在退出。");
    if (this.operation) throw new Error("正在切换视频，请稍后重试。");
    const request = playbackRequest(source, options);
    const controller = new AbortController();
    this.controller?.abort();
    this.controller = controller;
    const revision = this.snapshot.revision + 1;
    this.update({ opened: true, preparing: true, request, revision });
    const operation = (async () => {
      let media: PreparedPlayback | undefined;
      try {
        await this.releaseAll();
        controller.signal.throwIfAborted();
        media = await this.port.prepare(request, controller.signal);
        this.resources.add(media);
        if (controller.signal.aborted) {
          await this.release(media);
          return;
        }
        this.update({ opened: true, preparing: false, request, media, revision });
      } catch (error) {
        if (controller.signal.aborted) return;
        this.update({
          opened: true,
          preparing: false,
          request,
          revision,
          error: playbackError(error),
        });
        throw error;
      }
    })();
    this.operation = operation;
    try {
      await operation;
      return { started: !controller.signal.aborted };
    } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.controller?.abort();
    this.update({ opened: false, preparing: false, revision: this.snapshot.revision });
    const previous = this.operation;
    const closing = (async () => {
      await previous?.catch(() => {});
      await this.releaseAll();
    })();
    this.operation = this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.operation === closing) this.operation = undefined;
      this.closing = undefined;
    }
  }
  async shutdown() {
    this.stopped = true;
    await this.close();
  }
}

export function playbackError(error: unknown) {
  return error instanceof Error ? error.message : "视频加载失败，请检查文件或网络连接后重试。";
}
