import { Observable, serviceError } from "../metadata/shared";
import type { MovieDetails } from "../metadata/MetaTubeService";
import type { LibraryPort } from "./LibraryService";
import { StopUnconfirmedError } from "../downloads/ports";
import { normalizeCode } from "../scraping/identity";
import { imageCandidates } from "../images/ImageSourceService";

export function artworkSources(details: MovieDetails) {
  return {
    cover: imageCandidates([
      details.bigCoverUrl,
      details.coverUrl,
      details.bigThumbUrl,
      details.thumbUrl,
      ...(details.coverCandidates ?? []),
    ]),
    screenshots: [...new Set((details.previewImages ?? []).slice(0, 100))]
      .filter((url) => !!url.trim())
      .slice(0, 24),
  };
}

export interface CropArea {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface ArtworkTarget {
  directory: string;
  poster: string;
  code: string;
  title: string;
  source: { provider?: string; id?: string; homepage?: string; origin?: "metatube" };
  videos: { id: string; path: string; file_stamp: string; duration_ms: number }[];
}
export interface ArtworkTools {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, bytes: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  frame(path: string, output: string, seconds: number, signal: AbortSignal): Promise<void>;
  transform(
    buffers: ArrayBuffer[],
    sheet: boolean,
    crop: CropArea | undefined,
    signal: AbortSignal,
  ): Promise<ArrayBuffer>;
  download(url: string, referer: string, path: string, signal: AbortSignal): Promise<void>;
  copyCached?(urls: string[], referer: string, path: string, signal: AbortSignal): Promise<boolean>;
  details(target: ArtworkTarget, signal: AbortSignal): Promise<MovieDetails>;
}
type ImageRecord = { path: string; kind: "poster" | "screenshot" | "sheet"; seconds?: number };
export class ArtworkService extends Observable<{
  busy: boolean;
  action: string;
  processed: number;
  total: number;
  error: string;
  warning: string;
}> {
  private active?: { abort: AbortController; done: Promise<void> };
  private cleanup?: StopUnconfirmedError;
  private stopped = false;
  constructor(
    private port: Pick<LibraryPort, "request">,
    private tools: ArtworkTools,
    private refresh: () => Promise<void>,
  ) {
    super({ busy: false, action: "", processed: 0, total: 0, error: "", warning: "" });
  }
  private run(action: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (this.stopped || this.active) return Promise.reject(new Error("请等待当前图片任务结束。"));
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error("图片任务超过 10 分钟，已停止。")),
      600_000,
    );
    this.publish({ busy: true, action, processed: 0, total: 0, error: "", warning: "" });
    const done = Promise.resolve()
      .then(async () => {
        if (this.cleanup) {
          await this.cleanup.retry();
          this.cleanup = undefined;
        }
        abort.signal.throwIfAborted();
        await operation(abort.signal);
      })
      .catch((error: unknown) => {
        if (error instanceof StopUnconfirmedError) this.cleanup = error;
        this.publish({ error: abort.signal.aborted ? "图片处理已取消。" : serviceError(error) });
        throw error;
      })
      .finally(async () => {
        clearTimeout(timeout);
        await this.refresh().catch(() => {});
        this.active = undefined;
        this.publish({ busy: false });
      });
    this.active = { abort, done };
    return done;
  }
  private async batch(
    id: string,
    signal: AbortSignal,
    operation: (
      target: ArtworkTarget,
      temporary: string,
      add: (
        bytes: ArrayBuffer,
        kind: ImageRecord["kind"],
        seconds?: number,
        order?: number,
      ) => Promise<void>,
    ) => Promise<ArtworkTarget["videos"][number] | void>,
  ) {
    const target = await this.port.request<ArtworkTarget>("library.artwork.prepare", { id });
    signal.throwIfAborted();
    const temporary = `${target.directory}/.work-${crypto.randomUUID()}`;
    await this.tools.mkdir(temporary);
    const images: (ImageRecord & { order: number })[] = [];
    let committed = false;
    let commitStarted = false;
    const clean = async () => {
      // A lost RPC response may follow a committed transaction; preserve its files.
      if (!committed && !commitStarted)
        for (const image of images) await this.tools.remove(image.path).catch(() => {});
      await this.tools.remove(temporary);
    };
    try {
      const video = await operation(
        target,
        temporary,
        async (bytes, kind, seconds, order = images.length) => {
          signal.throwIfAborted();
          if (images.length >= 24 || bytes.byteLength > 20 * 1024 * 1024)
            throw new Error("图片数量或大小超过限制。");
          const path = `${target.directory}/${crypto.randomUUID()}.jpg`;
          images.push({ path, kind, seconds, order });
          await this.tools.write(path, bytes);
        },
      );
      signal.throwIfAborted();
      if (!images.length) throw new Error("未获得有效图片。");
      commitStarted = true;
      const result = await this.port.request<{ retired: string[] }>("library.artwork.commit", {
        id,
        images: images
          .sort((a, b) => a.order - b.order)
          .map(({ order: _order, ...image }) => image),
        expectedPoster: target.poster,
        video,
      });
      committed = true;
      for (const path of result.retired ?? [])
        await this.tools
          .remove(path)
          .catch(() => this.publish({ warning: "新封面已保存，旧封面文件暂未清理。" }));
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        throw new StopUnconfirmedError(async () => {
          await error.retry();
          await clean();
        });
      }
      await clean().catch(() => {});
      throw error;
    }
    await clean().catch(() => this.publish({ warning: "图片已保存，临时文件清理失败。" }));
  }
  cover(id: string, path: string, crop?: CropArea) {
    return this.run("保存封面", (signal) =>
      this.batch(id, signal, async (_target, _temporary, add) => {
        this.publish({ total: 1 });
        await add(
          await this.tools.transform([await this.tools.read(path)], false, crop, signal),
          "poster",
        );
        this.publish({ processed: 1 });
      }),
    );
  }
  preview(path: string, signal: AbortSignal) {
    return this.tools.read(path).then((bytes) => {
      signal.throwIfAborted();
      return this.tools.transform([bytes], false, undefined, signal);
    });
  }
  capture(id: string, count: number, sheet = false, videoId?: string) {
    return this.run(sheet ? "生成长图" : "截取画面", (signal) =>
      this.batch(id, signal, async (target, temporary, add) => {
        if (![1, 6, 12, 24].includes(count)) throw new Error("截图数量无效。");
        const video = target.videos.find((item) => item.id === videoId) ?? target.videos[0];
        if (!video || video.duration_ms <= 0)
          throw new Error("没有可抽帧的本地视频，请先扫描以获取时长。");
        this.publish({ total: count });
        const frames: ArrayBuffer[] = [];
        for (let index = 0; index < count; index++) {
          signal.throwIfAborted();
          const seconds = (video.duration_ms / 1000) * ((index + 1) / (count + 1)),
            path = `${temporary}/frame-${index}.jpg`;
          await this.tools.frame(video.path, path, seconds, signal);
          const buffer = await this.tools.read(path);
          if (sheet) frames.push(buffer);
          else
            await add(
              await this.tools.transform([buffer], false, undefined, signal),
              "screenshot",
              seconds,
            );
          this.publish({ processed: index + 1 });
        }
        if (sheet) await add(await this.tools.transform(frames, true, undefined, signal), "sheet");
        return video;
      }),
    );
  }
  fetch(id: string, cover: boolean, screenshots: boolean, suppliedDetails?: MovieDetails) {
    return this.run("获取图片", (signal) =>
      this.batch(id, signal, async (target, temporary, add) => {
        if (!cover && !screenshots) throw new Error("请至少选择一种图片。");
        const details = suppliedDetails ?? (await this.tools.details(target, signal));
        if (!target.code || normalizeCode(details.fields.code ?? "") !== normalizeCode(target.code))
          throw new Error("图片来源番号与作品不一致，请先刮削并确认资料。");
        const sources = artworkSources(details);
        const hasCover = cover && sources.cover.length > 0;
        const images: { urls: string[]; kind: ImageRecord["kind"] }[] = [
          ...(hasCover ? [{ urls: sources.cover, kind: "poster" as const }] : []),
          ...(screenshots
            ? sources.screenshots
                .slice(0, hasCover ? 23 : 24)
                .map((url) => ({ urls: [url], kind: "screenshot" as const }))
            : []),
        ];
        this.publish({ total: images.length });
        let failures = 0,
          processed = 0,
          next = 0;
        const stop = new AbortController();
        const active = AbortSignal.any([signal, stop.signal]);
        const worker = async () => {
          try {
            while (next < images.length) {
              active.throwIfAborted();
              const index = next++,
                image = images[index]!;
              const path = `${temporary}/download-${index}`;
              const transform = async () =>
                this.tools.transform([await this.tools.read(path)], false, undefined, active);
              let bytes: ArrayBuffer | undefined;
              try {
                // 先检查全部候选缓存，避免重新请求已失败的主图或已显示的备用图。
                if (await this.tools.copyCached?.(image.urls, details.homepage, path, active))
                  bytes = await transform();
              } catch (error) {
                if (error instanceof StopUnconfirmedError) throw error;
                active.throwIfAborted();
              }
              if (!bytes)
                for (const url of image.urls) {
                  active.throwIfAborted();
                  try {
                    await this.tools.download(url, details.homepage, path, active);
                    bytes = await transform();
                    break;
                  } catch (error) {
                    if (error instanceof StopUnconfirmedError) throw error;
                    active.throwIfAborted();
                  }
                }
              active.throwIfAborted();
              if (bytes) await add(bytes, image.kind, undefined, index);
              else failures++;
              this.publish({
                processed: ++processed,
                warning: failures ? `${failures} 张图片获取失败，已保留其余结果。` : "",
              });
            }
          } catch (error) {
            stop.abort(error);
            throw error;
          }
        };
        // 至多 4 张图片在途；等待所有任务收尾后，batch 才能提交或清理目录。
        const results = await Promise.allSettled(
          Array.from({ length: Math.min(4, images.length) }, worker),
        );
        const errors = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const pendingStops = new Set(
          errors
            .map(({ reason }) => reason)
            .filter(
              (error): error is StopUnconfirmedError => error instanceof StopUnconfirmedError,
            ),
        );
        if (pendingStops.size)
          throw new StopUnconfirmedError(async () => {
            const stopped = await Promise.allSettled(
              [...pendingStops].map(async (error) => {
                await error.retry();
                pendingStops.delete(error);
              }),
            );
            const failed = stopped.find((result) => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          });
        if (errors[0]) throw errors[0].reason;
      }),
    );
  }
  remove(id: string, images?: string[]) {
    return this.run("清理截图", async (signal) => {
      signal.throwIfAborted();
      const paths = await this.port.request<string[]>("library.artwork.remove", {
        id,
        images,
        clear: !images,
      });
      this.publish({ total: paths.length });
      for (const [index, path] of paths.entries()) {
        // Once detached, finish this bounded cleanup even if the user cancels.
        await this.tools
          .remove(path)
          .catch(() => this.publish({ warning: "部分图片文件未能删除，请检查文件占用。" }));
        this.publish({ processed: index + 1 });
      }
    });
  }
  cancel = () => this.active?.abort.abort();
  async shutdown() {
    this.stopped = true;
    this.cancel();
    await this.active?.done.catch(() => {});
    if (this.cleanup) {
      await this.cleanup.retry();
      this.cleanup = undefined;
    }
  }
}
