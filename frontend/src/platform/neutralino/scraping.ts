import { filesystem, os } from "@neutralinojs/lib";
import type { Runtime } from "./bootstrap";
import { NativeLibraryPort } from "./library";
import { findOnPath, runNativeProcess } from "./process";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { LibraryService } from "../../services/library/LibraryService";
import type { MetaTubeService } from "../../services/metadata/MetaTubeService";
import type { AiService } from "../../services/metadata/AiService";
import { ScrapeService } from "../../services/scraping/ScrapeService";
import type { ScrapePort, ScrapeTarget } from "../../services/scraping/ScrapeService";
import type { ScrapeTask } from "../../contracts/scraping";
import type { NativeVideo } from "../../contracts/library";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { createMetadataPipeline } from "./metadataPipeline";

// 应用级共享端口，批量添加不会重复注册 Extension 事件监听器。
const port = new NativeLibraryPort();

export function createScrapeService(
  runtime: Runtime,
  metatube: MetaTubeService,
  network: NetworkSettingsService,
  library: LibraryService,
  prepare: () => Promise<void>,
  ai?: AiService,
) {
  const available =
    runtime === "desktop" && (window as unknown as { NL_OS: string }).NL_OS === "Windows";
  const adapter: ScrapePort = {
    async load(offset) {
      await prepare();
      return port.request<ScrapeTask[]>("scraping.load", { offset });
    },
    async save(task, expectedRevision) {
      await port.request("scraping.save", { task, expectedRevision });
    },
    async remove(task) {
      await port.request("scraping.remove", { id: task.id, revision: task.revision });
    },
    async prepare(task, signal) {
      signal.throwIfAborted();
      const jobId = crypto.randomUUID();
      const cancel = () => {
        void port.request("library.scrape.cancel", { jobId }).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await port.request<ScrapeTarget>("library.scrape.prepare", {
          jobId,
          workId: task.workId,
          candidate: task.candidate,
          collect: task.collect,
          path: task.path,
        });
        signal.throwIfAborted();
        return { ...result, jobId };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async artwork(details, signal) {
      const urls = [
        ...new Set(
          [details.bigCoverUrl, details.coverUrl, details.bigThumbUrl, details.thumbUrl].filter(
            (url): url is string => !!url,
          ),
        ),
      ];
      if (!urls.length) throw new Error("来源未提供封面。");
      const curl = await findOnPath("curl.exe");
      if (!curl) throw new Error("找不到系统 curl。");
      const directory = `${await os.getPath("temp")}/javm-scrape-${crypto.randomUUID()}`;
      await filesystem.createDirectory(directory);
      const dispose = () => filesystem.remove(directory);
      try {
        const proxy = await network.getProxy();
        for (const url of urls) {
          signal.throwIfAborted();
          const location = new URL(url);
          if (
            !["http:", "https:"].includes(location.protocol) ||
            location.username ||
            location.password
          )
            continue;
          const path = `${directory}/artwork`;
          const result = await runNativeProcess(
            curl,
            [
              "--disable",
              "--silent",
              "--show-error",
              "--fail",
              "--location",
              "--max-redirs",
              "5",
              "--proto",
              "=http,https",
              "--proto-redir",
              "=http,https",
              "--connect-timeout",
              "8",
              "--max-time",
              "45",
              "--max-filesize",
              "20971520",
              "--proxy",
              proxy,
              "--referer",
              details.homepage,
              "--output",
              path,
              "--url",
              url,
            ],
            signal,
            undefined,
            true,
          );
          signal.throwIfAborted();
          if (result.exitCode === 0) {
            const stat = await filesystem.getStats(path);
            if (stat.isFile && stat.size > 0 && stat.size <= 20 * 1024 * 1024)
              return { path, dispose };
          }
        }
        throw new Error("封面下载失败，请检查来源与代理后重试。");
      } catch (error) {
        if (error instanceof StopUnconfirmedError) {
          // 工具可能仍在写入临时文件；确认终止后再删除和释放并发槽。
          throw new StopUnconfirmedError(async () => {
            await error.retry();
            await dispose().catch(() => {});
          });
        }
        await dispose().catch(() => {});
        throw error;
      }
    },
    commit(task, target, details, image) {
      return port.request<{ warning?: string }>("library.scrape.commit", {
        jobId: target.jobId ?? task.id,
        id: target.id,
        path: target.path,
        fileStamp: target.fileStamp,
        nfoStamp: target.nfoStamp ?? "",
        details,
        image,
      });
    },
    refresh: () => library.refreshAfterImport(),
  };
  const pipeline = createMetadataPipeline(metatube, available);
  const service = new ScrapeService(adapter, pipeline, available, ai?.recognizeForScrape);
  service.pipeline = pipeline;
  void service.initialize();
  return service;
}

export async function enqueueLibraryScrapes(
  service: ScrapeService,
  missingOnly: boolean,
  directory: string,
  signal: AbortSignal,
) {
  let count = 0;
  // 遍历稳定的全量分页，在本页筛选；刮削改变缺失状态时不会因 offset 跳过后续影片。
  for (let offset = 0; ; offset += 100) {
    signal.throwIfAborted();
    const page = await port.request<NativeVideo[]>("library.videos", { offset, limit: 100 });
    for (const video of page) {
      signal.throwIfAborted();
      if (missingOnly && (video.scan_status ?? 0) >= 2) continue;
      if (
        directory &&
        !(video.video_path ?? video.nfo_path)
          .replaceAll("\\", "/")
          .toLowerCase()
          .startsWith(`${directory.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()}/`)
      )
        continue;
      await service.enqueue({
        workId: video.id,
        name: video.title || video.local_id || "未命名作品",
      });
      count++;
    }
    if (page.length < 100) return count;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
