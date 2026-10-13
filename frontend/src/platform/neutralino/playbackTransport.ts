import { filesystem, os, server } from "@neutralinojs/lib";
import { findOnPath, runNativeProcess } from "./process";
import { toolExecutableName } from "./toolPaths";
import { mediaResourceUrl, readPlaybackCache } from "./playbackResources";
import type { MediaResponse, NativeMediaFetch } from "../../services/playback/PlaybackService";
import { StopUnconfirmedError } from "../../services/downloads/ports";

/** HLS 跨域/Referer 回退；发布版用资源挂载传输，开发版按小块读取二进制。 */
export class NativeMediaTransport {
  private controller = new AbortController();
  private setup?: Promise<{ directory: string; prefix: string; curl: string }>;
  private jobs = new Set<Promise<MediaResponse>>();
  private running = 0;
  private waiting: (() => void)[] = [];
  private unmounted = false;
  private disposed = false;
  private stopRetries = new Set<() => Promise<void>>();
  constructor(private referer?: string) {}

  private initialize() {
    this.setup ??= (async () => {
      const curl = await findOnPath(toolExecutableName("curl"));
      if (!curl) throw new Error("找不到系统 curl，无法加载需要原生请求的视频源。");
      const id = crypto.randomUUID();
      const directory = `${await os.getPath("temp")}/javm-playback-${id}`;
      const prefix = `/javm-playback-cache/${id}`;
      await filesystem.createDirectory(directory);
      try {
        await server.mount(prefix, directory);
      } catch (error) {
        await filesystem.remove(directory);
        throw error;
      }
      return { directory, prefix, curl };
    })();
    return this.setup;
  }

  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.running < 3) {
      this.running++;
      return;
    }
    if (this.waiting.length >= 8) throw new Error("视频请求过多，请稍后重试。");
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiting = this.waiting.filter((item) => item !== start);
        reject(signal.reason);
      };
      this.waiting.push(start);
      signal.addEventListener("abort", abort, { once: true });
    });
    // 运行名额由 release 转交，取消后也必须释放。
    if (signal.aborted) {
      this.release();
      signal.throwIfAborted();
    }
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  fetch: NativeMediaFetch = (url, signal, range) => {
    return this.schedule(url, signal, range);
  };

  probe(url: string, signal: AbortSignal) {
    return this.schedule(url, signal, undefined, true);
  }

  private schedule(
    url: string,
    signal: AbortSignal,
    range?: { start: number; end?: number },
    head = false,
  ) {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const job = this.request(url, combined, range, head).catch((error: unknown) => {
      if (error instanceof StopUnconfirmedError) {
        this.stopRetries.add(error.retry);
        this.controller.abort();
      }
      throw error;
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }

  private async request(
    url: string,
    signal: AbortSignal,
    range?: { start: number; end?: number },
    head = false,
  ): Promise<MediaResponse> {
    if (!/^https?:\/\//i.test(url)) throw new Error("网络播放仅支持 HTTP／HTTPS。");
    await this.acquire(signal);
    let file: string | undefined;
    try {
      const { curl, directory, prefix } = await this.initialize();
      signal.throwIfAborted();
      const name = `${crypto.randomUUID()}.bin`;
      file = `${directory}/${name}`;
      const args = [
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--max-redirs",
        "8",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--output",
        file,
        "--write-out",
        "%{http_code}\n%{url_effective}\n%{content_type}",
      ];
      if (head) args.push("--head");
      else args.push("--max-filesize", "67108864");
      if (this.referer) args.push("--referer", this.referer);
      if (range)
        args.push("--range", `${range.start}-${range.end === undefined ? "" : range.end - 1}`);
      args.push("--url", url);
      const result = await runNativeProcess(curl, args, signal, undefined, true);
      signal.throwIfAborted();
      if (result.exitCode !== 0)
        throw new Error(
          `视频源请求失败（curl ${result.exitCode}），请检查链接有效期、网络或访问权限。`,
        );
      let data = await readPlaybackCache(file, mediaResourceUrl(`${prefix}/${name}`), signal);
      const [status, effectiveUrl, contentType] = result.stdOut.trim().split(/\r?\n/);
      if (range && status === "200") data = data.slice(range.start, range.end);
      return { data, url: effectiveUrl || url, contentType };
    } finally {
      if (file) await filesystem.remove(file).catch(() => {});
      this.release();
    }
  }
  async dispose() {
    if (this.disposed) return;
    this.controller.abort();
    await Promise.allSettled([...this.jobs]);
    for (const retry of this.stopRetries) {
      try {
        await retry();
        this.stopRetries.delete(retry);
      } catch {
        throw new Error("未能确认视频请求进程已停止，请重试关闭播放器或退出应用。");
      }
    }
    const setup = await this.setup?.catch(() => undefined);
    if (setup) {
      if (!this.unmounted) {
        await server.unmount(setup.prefix);
        this.unmounted = true;
      }
      await filesystem.remove(setup.directory);
    }
    this.disposed = true;
  }
}
