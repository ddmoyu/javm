import { Observable, serviceError } from "../metadata/shared";
import type { MovieDetails } from "../metadata/MetaTubeService";
import type { LibraryPort } from "./LibraryService";
import { StopUnconfirmedError } from "../downloads/ports";
import { normalizeCode } from "../scraping/identity";

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
  source: { provider?: string; id?: string };
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
      add: (bytes: ArrayBuffer, kind: ImageRecord["kind"], seconds?: number) => Promise<void>,
    ) => Promise<ArtworkTarget["videos"][number] | void>,
  ) {
    const target = await this.port.request<ArtworkTarget>("library.artwork.prepare", { id });
    signal.throwIfAborted();
    const temporary = `${target.directory}/.work-${crypto.randomUUID()}`;
    await this.tools.mkdir(temporary);
    const images: ImageRecord[] = [];
    let committed = false;
    let commitStarted = false;
    const clean = async () => {
      // A lost RPC response may follow a committed transaction; preserve its files.
      if (!committed && !commitStarted)
        for (const image of images) await this.tools.remove(image.path).catch(() => {});
      await this.tools.remove(temporary);
    };
    try {
      const video = await operation(target, temporary, async (bytes, kind, seconds) => {
        signal.throwIfAborted();
        if (images.length >= 24 || bytes.byteLength > 20 * 1024 * 1024)
          throw new Error("图片数量或大小超过限制。");
        const path = `${target.directory}/${crypto.randomUUID()}.jpg`;
        images.push({ path, kind, seconds });
        await this.tools.write(path, bytes);
      });
      signal.throwIfAborted();
      if (!images.length) throw new Error("未获得有效图片。");
      commitStarted = true;
      const result = await this.port.request<{ retired: string[] }>("library.artwork.commit", {
        id,
        images,
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
  fetch(id: string, cover: boolean, screenshots: boolean) {
    return this.run("获取图片", (signal) =>
      this.batch(id, signal, async (target, temporary, add) => {
        if (!cover && !screenshots) throw new Error("请至少选择一种图片。");
        const details = await this.tools.details(target, signal);
        if (!target.code || normalizeCode(details.fields.code ?? "") !== normalizeCode(target.code))
          throw new Error("图片来源番号与作品不一致，请先刮削并确认资料。");
        const coverUrl =
          details.bigCoverUrl ?? details.coverUrl ?? details.bigThumbUrl ?? details.thumbUrl;
        const images: { url: string; kind: ImageRecord["kind"] }[] = [
          ...(cover && coverUrl ? [{ url: coverUrl, kind: "poster" as const }] : []),
          ...(screenshots
            ? (details.previewImages ?? [])
                .slice(0, 23)
                .map((url) => ({ url, kind: "screenshot" as const }))
            : []),
        ];
        this.publish({ total: images.length });
        let failures = 0;
        for (const [index, image] of images.entries()) {
          signal.throwIfAborted();
          const path = `${temporary}/download-${index}`;
          try {
            await this.tools.download(image.url, details.homepage, path, signal);
            await add(
              await this.tools.transform([await this.tools.read(path)], false, undefined, signal),
              image.kind,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof StopUnconfirmedError) throw error;
            failures++;
          }
          this.publish({
            processed: index + 1,
            warning: failures ? `${failures} 张图片获取失败，已保留其余结果。` : "",
          });
        }
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
