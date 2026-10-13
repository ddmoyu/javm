import { filesystem, server } from "@neutralinojs/lib";
import { applicationCachePath } from "./applicationPaths";
import { ImageSourceService } from "../../services/images/ImageSourceService";
import type { ImageSourcePort } from "../../services/images/ImageSourceService";
import type { Runtime } from "./bootstrap";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { requestHttp } from "./http";
import { mediaResourceUrl } from "./playbackResources";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { logEvent } from "../../services/logging/events";
import { yieldToUi } from "../../services/yieldToUi";
import { isDmmImage } from "../../services/images/dmm";

const IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const namePattern = /^([a-f0-9]{64})\.(jpg|png|webp|gif|avif)$/;

function webUrl(value: string) {
  if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("图片地址无效。");
  const url = new URL(value.startsWith("//") ? `https:${value}` : value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("图片地址无效。");
  url.hash = "";
  return url.href;
}
export function imageExtension(header: Uint8Array): string | undefined {
  const text = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "jpg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value))
    return "png";
  if (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a") return "gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
  if (text(4, 8) === "ftyp" && ["avif", "avis"].includes(text(8, 12))) return "avif";
}

export function createImageSourcePort(
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
): ImageSourcePort {
  const prefix = `/javm-images/${crypto.randomUUID()}`;
  const files = new Map<string, { name: string; bytes: number; used: number; created: number }>();
  const failed = new Map<string, number>();
  const pendingStops = new Set<() => Promise<void>>();
  let directory = "",
    mounted = false,
    ready: Promise<void> | undefined;
  let commit = Promise.resolve();
  const keyOf = async (url: string, referer?: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([url, referer ?? ""])),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const exclusive = (operation: () => Promise<void>) => {
    const next = commit.then(operation);
    commit = next.catch(() => {});
    return next;
  };
  async function remove(key: string) {
    const file = files.get(key);
    if (!file) return;
    const path = `${directory}/${file.name}`;
    if (
      await filesystem.getStats(path).catch((error: unknown) => {
        if ((error as { code?: string }).code === "NE_FS_NOPATHE") return null;
        throw error;
      })
    )
      await filesystem.remove(path);
    files.delete(key);
  }
  async function prune(reserved = 0) {
    let bytes = [...files.values()].reduce((sum, file) => sum + file.bytes, 0);
    for (const [key, file] of [...files].sort((a, b) => a[1].used - b[1].used)) {
      if (
        Date.now() - file.created < MAX_AGE &&
        files.size < MAX_FILES &&
        bytes + reserved <= CACHE_BYTES
      )
        continue;
      await remove(key);
      bytes -= file.bytes;
    }
  }
  async function initialize() {
    if (import.meta.env.DEV) throw new Error("开发模式只使用安全图片夹具。");
    directory = await applicationCachePath("image-previews-v1");
    try {
      await filesystem.createDirectory(directory);
    } catch (error) {
      if (!(await filesystem.getStats(directory).catch(() => null))?.isDirectory) throw error;
    }
    const entries = await filesystem.readDirectory(directory);
    if (entries.length > 384) throw new Error("图片缓存文件超过限制。");
    for (const entry of entries) {
      const match = namePattern.exec(entry.entry);
      if (match) {
        const stat = await filesystem.getStats(`${directory}/${entry.entry}`);
        if (stat.isFile && stat.size > 0 && stat.size <= IMAGE_BYTES)
          files.set(match[1]!, {
            name: entry.entry,
            bytes: stat.size,
            used: stat.modifiedAt,
            created: stat.modifiedAt,
          });
        else if (stat.isFile) await filesystem.remove(`${directory}/${entry.entry}`);
      } else if (/^download-[a-f0-9-]+\.part$/.test(entry.entry)) {
        await filesystem.remove(`${directory}/${entry.entry}`);
      }
      await yieldToUi();
    }
    await prune();
    await server.mount(prefix, directory);
    mounted = true;
  }
  const ensure = () =>
    (ready ??= initialize().catch((error) => {
      ready = undefined;
      throw error;
    }));
  function rememberFailure(key: string) {
    failed.delete(key);
    failed.set(key, Date.now() + 30_000);
    while (failed.size > MAX_FILES) failed.delete(failed.keys().next().value!);
  }
  return {
    async copyCached(input, page, destination, signal) {
      const key = await keyOf(webUrl(input), page ? webUrl(page) : undefined);
      await ensure();
      signal.throwIfAborted();
      let copied = false;
      // 与淘汰、失效处理共用队列，复制完成前缓存文件不会被移除。
      await exclusive(async () => {
        signal.throwIfAborted();
        const cached = files.get(key);
        if (
          !cached ||
          Date.now() - cached.created >= MAX_AGE ||
          (failed.get(key) ?? 0) > Date.now()
        )
          return;
        const source = `${directory}/${cached.name}`;
        const stat = await filesystem.getStats(source).catch((error: unknown) => {
          if ((error as { code?: string }).code === "NE_FS_NOPATHE") return null;
          throw error;
        });
        if (!stat?.isFile || !stat.size || stat.size > IMAGE_BYTES) {
          files.delete(key);
          return;
        }
        signal.throwIfAborted();
        await filesystem.copy(source, destination, {
          overwrite: false,
          recursive: false,
          skip: false,
        });
        signal.throwIfAborted();
        cached.used = Date.now();
        copied = true;
      });
      return copied;
    },
    async load(input, page, signal) {
      const url = webUrl(input),
        referer = page ? webUrl(page) : undefined;
      await ensure();
      signal.throwIfAborted();
      const key = await keyOf(url, referer);
      if ((failed.get(key) ?? 0) > Date.now()) throw new Error("图片暂不可用。");
      const cached = files.get(key);
      if (cached && Date.now() - cached.created < MAX_AGE) {
        cached.used = Date.now();
        return mediaResourceUrl(`${prefix}/${cached.name}`);
      }
      if (pendingStops.size) throw new Error("图片请求尚未确认停止。");
      await beforeFetch();
      signal.throwIfAborted();
      const temporary = `${directory}/download-${crypto.randomUUID()}.part`;
      const cleanup = () => filesystem.remove(temporary).catch(() => {});
      let deferred = false;
      try {
        const proxy = await network.getProxy();
        signal.throwIfAborted();
        const result = await requestHttp(
          {
            purpose: "artwork",
            url,
            proxy,
            output: temporary,
            headers: referer ? { Referer: referer } : {},
            maxBytes: IMAGE_BYTES,
            timeoutMs: 15_000,
            connectTimeoutMs: 6000,
            // DMM 缺图会 302 到占位图，按失败处理并回退下一候选。
            maxRedirects: isDmmImage(url) ? 0 : 3,
            cacheTtlMs: 60_000,
          },
          signal,
        );
        signal.throwIfAborted();
        if (result.exitCode || result.status !== 200) {
          logEvent("warn", "network", "image_failed", "图片来源请求失败", {
            status: result.status,
            exitCode: result.exitCode,
            proxyEnabled: !!proxy,
          });
          throw new Error("图片来源暂不可用。");
        }
        const stat = await filesystem.getStats(temporary);
        if (!stat.isFile || !stat.size || stat.size > IMAGE_BYTES)
          throw new Error("图片响应超过限制。");
        const ext = imageExtension(
          new Uint8Array(
            await filesystem.readBinaryFile(temporary, { pos: 0, size: Math.min(32, stat.size) }),
          ),
        );
        const type = result.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
        if (!ext || (type && !type.startsWith("image/") && type !== "application/octet-stream")) {
          logEvent("warn", "network", "image_invalid", "图片来源返回了无效图片", {
            status: result.status,
            bytes: stat.size,
          });
          throw new Error("来源返回的不是有效图片。");
        }
        const name = `${key}.${ext}`;
        await exclusive(async () => {
          signal.throwIfAborted();
          const previous = files.get(key);
          if (previous && Date.now() - previous.created < MAX_AGE) return;
          await remove(key);
          await prune(stat.size);
          await filesystem.move(temporary, `${directory}/${name}`);
          files.set(key, { name, bytes: stat.size, used: Date.now(), created: Date.now() });
        });
        signal.throwIfAborted();
        return mediaResourceUrl(`${prefix}/${files.get(key)!.name}`);
      } catch (error) {
        if (error instanceof StopUnconfirmedError) {
          deferred = true;
          pendingStops.add(async () => {
            await error.retry();
            await cleanup();
          });
        }
        if (!signal.aborted) rememberFailure(key);
        throw error;
      } finally {
        if (!deferred) await cleanup();
      }
    },
    async invalidate(input, page) {
      const key = await keyOf(webUrl(input), page ? webUrl(page) : undefined);
      rememberFailure(key);
      await exclusive(() => remove(key));
    },
    async shutdown() {
      await ready?.catch(() => {});
      await commit;
      for (const retry of pendingStops) {
        await retry();
        pendingStops.delete(retry);
      }
      if (mounted) {
        await server.unmount(prefix);
        mounted = false;
      }
    },
  };
}

export function createImageSources(
  runtime: Runtime,
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
) {
  return new ImageSourceService(
    runtime === "desktop" && !import.meta.env.DEV
      ? createImageSourcePort(network, beforeFetch)
      : undefined,
  );
}
