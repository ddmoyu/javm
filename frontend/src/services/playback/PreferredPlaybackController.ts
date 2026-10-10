import type { PlaybackController } from "./PlaybackService";
import type { PlaybackSettingsService } from "./PlaybackSettingsService";
import { playbackRequest } from "./source";
import type { PlaybackOptions, PlaybackRequest } from "./source";

/** 所有业务播放入口共用偏好；子窗口只负责实际内置播放。 */
export class PreferredPlaybackController implements PlaybackController {
  private opening = false;
  private stopped = false;
  private operation?: Promise<void>;
  private abort?: AbortController;
  constructor(
    private internal: PlaybackController,
    private settings: PlaybackSettingsService,
    private external: (
      request: PlaybackRequest,
      path: string,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}
  getSnapshot = () => this.internal.getSnapshot();
  subscribe = (listener: () => void) => this.internal.subscribe(listener);
  async play(source: string, options?: PlaybackOptions) {
    if (this.stopped) throw new Error("应用正在退出。");
    if (this.opening) throw new Error("正在切换视频，请稍后重试。");
    const request = playbackRequest(source, options);
    const abort = new AbortController();
    this.abort = abort;
    this.opening = true;
    const operation = (async () => {
      await this.settings.initialize();
      if (this.stopped || abort.signal.aborted) return;
      const { settings, error } = this.settings.getSnapshot();
      if (error) throw new Error(error);
      if (settings.defaultPlayer === "external") {
        await this.external(request, settings.externalPlayerPath, abort.signal);
        await this.internal.close();
      } else await this.internal.play(source, options);
    })();
    this.operation = operation;
    try {
      await operation;
    } finally {
      this.opening = false;
      this.operation = undefined;
    }
  }
  async close() {
    this.abort?.abort();
    await this.internal.close();
    await this.operation?.catch(() => {});
  }
  async shutdown() {
    this.stopped = true;
    this.abort?.abort();
    await this.internal.shutdown();
    await this.operation?.catch(() => {});
  }
}
