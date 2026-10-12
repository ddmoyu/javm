import { filesystem } from "@neutralinojs/lib";
import { ArtworkService } from "../../services/library/ArtworkService";
import type { ArtworkTools } from "../../services/library/ArtworkService";
import type { LibraryService } from "../../services/library/LibraryService";
import type { MetaTubeService } from "../../services/metadata/MetaTubeService";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { Runtime } from "./bootstrap";
import { NativeLibraryPort } from "./library";
import { nativeDownloadHost } from "./downloadHost";
import { runNativeProcess } from "./process";
import { requestHttp } from "./http";
import { normalizeCode } from "../../services/scraping/identity";
import { webUrl } from "../../services/streamResolution/shared";
import type { ImageSourceService } from "../../services/images/ImageSourceService";
import { yieldToUi } from "../../services/yieldToUi";
import { AutoCoverService } from "../../services/library/AutoCoverService";
import { logEvent } from "../../services/logging/events";
import { isDmmImage } from "../../services/images/dmm";

export function createArtworkService(
  runtime: Runtime,
  library: LibraryService,
  metatube: MetaTubeService,
  network: NetworkSettingsService,
  ffmpegPath: () => string,
  images: ImageSourceService,
) {
  if (runtime !== "desktop") return;
  const tools: ArtworkTools = {
    mkdir: (path) => filesystem.createDirectory(path),
    async read(path) {
      const stat = await filesystem.getStats(path);
      if (!stat.isFile || stat.size <= 0 || stat.size > 20 * 1024 * 1024)
        throw new Error("请选择不超过 20 MiB 的图片。");
      const bytes = new Uint8Array(stat.size);
      for (let position = 0; position < bytes.length;) {
        const chunk = await filesystem.readBinaryFile(path, {
          pos: position,
          size: Math.min(262144, bytes.length - position),
        });
        if (!chunk.byteLength) throw new Error("图片文件读取不完整。");
        bytes.set(new Uint8Array(chunk), position);
        position += chunk.byteLength;
        await yieldToUi();
      }
      return bytes.buffer;
    },
    async write(path, bytes) {
      for (let position = 0; position < bytes.byteLength; position += 262144) {
        const chunk = bytes.slice(position, position + 262144);
        if (position === 0) await filesystem.writeBinaryFile(path, chunk);
        else await filesystem.appendBinaryFile(path, chunk);
        await yieldToUi();
      }
    },
    copyCached: (urls, referer, path, signal) => images.copyCached(urls, referer, path, signal),
    async remove(path) {
      if (
        !/\/metadata\/[A-Za-z0-9_-]+\/images\/(?:[a-f0-9-]+\.jpg|\.work-[a-f0-9-]+)$/i.test(
          path.replaceAll("\\", "/"),
        )
      )
        throw new Error("图片清理路径无效。");
      try {
        await filesystem.getStats(path);
      } catch (error) {
        if ((error as { code?: string }).code === "NE_FS_NOPATHE") return;
        throw error;
      }
      await filesystem.remove(path);
    },
    async frame(path, output, seconds, signal) {
      const executable = await nativeDownloadHost.tool("ffmpeg", ffmpegPath());
      const result = await runNativeProcess(
        executable,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-n",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          seconds.toFixed(3),
          "-i",
          path,
          "-an",
          "-sn",
          "-frames:v",
          "1",
          "-vf",
          "scale='min(1280,iw)':-2",
          "-q:v",
          "3",
          "-threads",
          "2",
          output,
        ],
        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        undefined,
        true,
      );
      if (result.exitCode !== 0) throw new Error("视频抽帧失败，请检查视频与 FFmpeg。");
    },
    transform(buffers, sheet, crop, signal) {
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const worker = new Worker(
          new URL("../../services/library/artwork.worker.ts", import.meta.url),
          { type: "module" },
        );
        const cleanup = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", cancel);
          worker.terminate();
        };
        const cancel = () => {
          cleanup();
          reject(signal.reason ?? new Error("图片处理已取消。"));
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("图片处理超时。"));
        }, 30_000);
        signal.addEventListener("abort", cancel, { once: true });
        worker.onmessage = (event: MessageEvent<{ bytes?: ArrayBuffer; error?: string }>) => {
          cleanup();
          if (event.data.bytes) resolve(event.data.bytes);
          else reject(new Error(event.data.error || "图片处理失败。"));
        };
        worker.onerror = () => {
          cleanup();
          reject(new Error("后台图片处理失败。"));
        };
        worker.postMessage({ buffers, sheet, crop }, buffers);
      });
    },
    async download(url, referer, path, signal) {
      const result = await requestHttp(
        {
          purpose: "artwork",
          url: webUrl(url),
          proxy: await network.getProxy(),
          output: path,
          headers: referer ? { Referer: webUrl(referer) } : {},
          maxRedirects: isDmmImage(url) ? 0 : 3,
          maxBytes: 20 * 1024 * 1024,
          timeoutMs: 30_000,
          connectTimeoutMs: 8000,
          cacheTtlMs: 60_000,
        },
        signal,
      );
      if (result.exitCode !== 0 || result.status < 200 || result.status >= 300)
        throw new Error("图片下载失败。");
    },
    async details(target, signal) {
      const source = target.source;
      if (source.provider === "JavBus" && source.origin !== "metatube") {
        if (
          !source.homepage ||
          new URL(source.homepage).origin !== "https://www.javbus.com" ||
          !library.catalog
        )
          throw new Error("作品缺少有效的来源网页，请重新从发现页保存资料。");
        return library.catalog.works.readDetails(
          { url: source.homepage, code: target.code, title: target.title },
          signal,
        );
      }
      if (source.origin !== "metatube")
        throw new Error("作品尚未手动刮削，请先使用“刮削资料”获取封面与预览。");
      let candidate =
        target.source.provider && target.source.provider !== "AVWikiDB" && target.source.id
          ? {
              provider: target.source.provider,
              id: target.source.id,
              code: target.code,
              title: target.title,
            }
          : undefined;
      if (!candidate)
        candidate = (await metatube.search(target.code, signal)).find(
          (item) => normalizeCode(item.code) === normalizeCode(target.code),
        );
      if (!candidate) throw new Error("未找到番号一致的图片来源，请先确认资料。");
      return metatube.details(candidate, signal);
    },
  };
  library.autoCover = new AutoCoverService(
    new NativeLibraryPort(),
    tools,
    () => library.refreshAfterImport(),
    (message) => logEvent("info", "library", "auto_cover", message),
  );
  return new ArtworkService(new NativeLibraryPort(), tools, () => library.refreshAfterImport());
}
