import { Observable, serviceError } from "../metadata/shared";
import type { LibraryPort } from "./LibraryService";
import type { ArtworkTools } from "./ArtworkService";
import { StopUnconfirmedError } from "../downloads/ports";

/** 没有封面、但有可截帧本地视频的作品（由原生扩展按作品 ID 分页列出）。 */
export interface PendingCover {
  id: string;
  video_id: string;
  path: string;
  file_stamp: string;
  duration_ms: number;
}
export interface AutoCoverState {
  running: boolean;
  processed: number;
  created: number;
  failed: number;
  error: string;
}
/** 同时运行的 FFmpeg 截帧进程数。 */
const parallel = 2;
/** 每页向原生扩展请求的作品数。 */
const pageSize = 50;
/** 每生成这么多张封面刷新一次片库，让封面逐步出现。 */
const refreshEvery = 10;

/** 截帧位置：时长的 10%，避开片头黑屏，并留出 1 秒边界。 */
export function autoCoverSeconds(durationMs: number) {
  const duration = durationMs / 1000;
  return Math.max(Math.min(duration * 0.1, Math.max(duration - 1, 0)), Math.min(1, duration / 2));
}

/**
 * 扫描后为没有封面的作品自动截取一帧作为封面。应用级后台服务，独立于页面；
 * 封面以“自动”标记提交，之后刮削到的来源封面或手动设置的封面会替换它。
 */
export class AutoCoverService extends Observable<AutoCoverState> {
  private active?: { abort: AbortController; done: Promise<void> };
  private again = false;
  private stopped = false;
  constructor(
    private port: Pick<LibraryPort, "request">,
    private tools: Pick<
      ArtworkTools,
      "mkdir" | "read" | "write" | "remove" | "frame" | "transform"
    >,
    private refresh: () => Promise<void>,
    private log: (message: string) => void = () => {},
  ) {
    super({ running: false, processed: 0, created: 0, failed: 0, error: "" });
  }
  /** 请求一次检查；运行中再次请求时，本轮结束后补跑一轮。 */
  schedule() {
    if (this.stopped) return;
    if (this.active) {
      this.again = true;
      return;
    }
    const abort = new AbortController();
    const done = this.run(abort.signal)
      .catch((error: unknown) => {
        if (!abort.signal.aborted) this.publish({ error: serviceError(error) });
      })
      .finally(() => {
        this.active = undefined;
        this.publish({ running: false });
        if (this.again && !this.stopped) {
          this.again = false;
          this.schedule();
        }
      });
    this.active = { abort, done };
  }
  private async run(signal: AbortSignal) {
    this.publish({ running: true, processed: 0, created: 0, failed: 0, error: "" });
    let after = "",
      created = 0,
      failed = 0,
      sinceRefresh = 0;
    try {
      while (!signal.aborted) {
        const page = await this.port.request<PendingCover[]>("library.artwork.pending", {
          after,
          limit: pageSize,
        });
        if (!page.length) break;
        after = page.at(-1)!.id;
        let next = 0;
        const worker = async () => {
          while (next < page.length) {
            signal.throwIfAborted();
            const item = page[next++]!;
            const outcome = await this.cover(item, signal);
            if (outcome === "created") {
              created++;
              if (++sinceRefresh >= refreshEvery) {
                sinceRefresh = 0;
                await this.refresh().catch(() => {});
              }
            } else if (outcome === "failed") failed++;
            this.publish({ processed: created + failed, created, failed });
          }
        };
        await Promise.all(Array.from({ length: Math.min(parallel, page.length) }, worker));
        if (page.length < pageSize) break;
      }
    } finally {
      if (sinceRefresh) await this.refresh().catch(() => {});
      if (created || failed)
        this.log(`自动封面：生成 ${created} 张${failed ? `，${failed} 个视频截帧失败` : ""}。`);
    }
  }
  private async cover(item: PendingCover, signal: AbortSignal) {
    const target = await this.port.request<{ directory: string; poster: string }>(
      "library.artwork.prepare",
      { id: item.id },
    );
    if (target.poster) return "skipped";
    const temporary = `${target.directory}/.work-${crypto.randomUUID()}`;
    const output = `${target.directory}/${crypto.randomUUID()}.jpg`;
    let committed = false;
    try {
      await this.tools.mkdir(temporary);
      const seconds = autoCoverSeconds(item.duration_ms);
      const frame = `${temporary}/frame.jpg`;
      await this.tools.frame(item.path, frame, seconds, signal);
      const bytes = await this.tools.transform(
        [await this.tools.read(frame)],
        false,
        undefined,
        signal,
      );
      await this.tools.write(output, bytes);
      const result = await this.port.request<{ skipped?: boolean }>("library.artwork.commit", {
        id: item.id,
        images: [{ path: output, kind: "poster", seconds }],
        expectedPoster: "",
        automatic: true,
        video: { id: item.video_id, file_stamp: item.file_stamp },
      });
      committed = !result.skipped;
      return committed ? "created" : "skipped";
    } catch (error) {
      if (error instanceof StopUnconfirmedError || signal.aborted) throw error;
      // 片库正在扫描时停止本轮，扫描结束后会重新安排。
      if (/片库操作完成后/.test(serviceError(error))) throw error;
      await this.port
        .request("library.artwork.failed", { id: item.id, fileStamp: item.file_stamp })
        .catch(() => {});
      return "failed";
    } finally {
      if (!committed) await this.tools.remove(output).catch(() => {});
      await this.tools.remove(temporary).catch(() => {});
    }
  }
  async shutdown() {
    this.stopped = true;
    this.active?.abort.abort();
    await this.active?.done.catch(() => {});
  }
}
