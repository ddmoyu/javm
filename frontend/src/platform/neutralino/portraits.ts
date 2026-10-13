import { filesystem, server } from "@neutralinojs/lib";
import { applicationCachePath } from "./applicationPaths";
import type { PortraitPort } from "../../services/catalog/PortraitService";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { gfriendsIndexSources, validPortraitUrl } from "../../services/catalog/portraitUrls";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { requestHttp } from "./http";
import { mediaResourceUrl } from "./playbackResources";
import { yieldToUi } from "../../services/yieldToUi";

const IMAGE_BYTES = 2 * 1024 * 1024;
const INDEX_BYTES = 16 * 1024 * 1024;
const CACHE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 1000;
export function createPortraitPort(
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
): PortraitPort {
  const prefix = `/javm-portraits/${crypto.randomUUID()}`;
  const files = new Map<string, { bytes: number; used: number }>();
  const pendingStops = new Set<() => Promise<void>>();
  let directory = "",
    mounted = false,
    ready: Promise<void> | undefined;
  let commit = Promise.resolve();
  const assertRelease = () => {
    if (import.meta.env.DEV) throw new Error("开发模式只使用占位头像。");
  };
  async function prune(reserved = 0) {
    let total = [...files.values()].reduce((sum, file) => sum + file.bytes, 0);
    const oldest = [...files].sort((a, b) => a[1].used - b[1].used);
    while (
      (files.size > MAX_FILES - (reserved ? 1 : 0) || total + reserved > CACHE_BYTES) &&
      oldest.length
    ) {
      const [name, file] = oldest.shift()!;
      await filesystem.remove(`${directory}/${name}`);
      files.delete(name);
      total -= file.bytes;
    }
  }
  async function initialize() {
    assertRelease();
    directory = await applicationCachePath("portraits");
    try {
      await filesystem.createDirectory(directory);
    } catch (error) {
      if (!(await filesystem.getStats(directory).catch(() => null))?.isDirectory) throw error;
    }
    const entries = await filesystem.readDirectory(directory);
    if (entries.length > 1200) throw new Error("头像缓存文件超过限制，请清理缓存后重试。");
    for (const entry of entries) {
      if (/^[a-f0-9]{64}\.jpg$/.test(entry.entry)) {
        const stat = await filesystem.getStats(`${directory}/${entry.entry}`);
        if (stat.isFile && stat.size > 0 && stat.size <= IMAGE_BYTES)
          files.set(entry.entry, { bytes: stat.size, used: stat.modifiedAt });
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
  const filename = async (key: string) =>
    `${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}.jpg`;
  async function download(url: string, maxBytes: number, signal: AbortSignal) {
    assertRelease();
    await ensure();
    signal.throwIfAborted();
    for (const retry of pendingStops) {
      await retry();
      pendingStops.delete(retry);
    }
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
          purpose: "portrait",
          url,
          proxy,
          output: temporary,
          headers: {
            Accept:
              maxBytes === INDEX_BYTES ? "application/json" : "image/jpeg,image/*;q=0.9,*/*;q=0.8",
          },
          maxBytes,
          timeoutMs: 20_000,
          cacheTtlMs: 300_000,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.exitCode || result.status !== 200) throw new Error("头像来源暂不可用。");
      const stat = await filesystem.getStats(temporary);
      if (!stat.isFile || !stat.size || stat.size > maxBytes) throw new Error("头像响应超过限制。");
      return { temporary, bytes: stat.size, cleanup };
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        deferred = true;
        pendingStops.add(async () => {
          await error.retry();
          await cleanup();
        });
      }
      if (!deferred) await cleanup();
      throw error;
    }
  }
  async function readIndex(path: string) {
    const stat = await filesystem.getStats(path);
    if (!stat.isFile || !stat.size || stat.size > INDEX_BYTES) throw new Error("头像索引无效。");
    const decoder = new TextDecoder();
    let text = "";
    for (let pos = 0; pos < stat.size; pos += 64 * 1024) {
      const buffer = await filesystem.readBinaryFile(path, {
        pos,
        size: Math.min(64 * 1024, stat.size - pos),
      });
      text += decoder.decode(buffer, { stream: true });
      await yieldToUi();
    }
    return text + decoder.decode();
  }
  return {
    async cached(dimension, names, signal) {
      await ensure();
      signal.throwIfAborted();
      const result: Record<string, string> = Object.create(null);
      for (const name of names) {
        signal.throwIfAborted();
        const file = await filename(`${dimension}:${name}`);
        if (files.has(file)) {
          files.get(file)!.used = Date.now();
          result[name] = mediaResourceUrl(`${prefix}/${file}`);
        }
      }
      return result;
    },
    async load(url, signal, key) {
      if (!validPortraitUrl(url)) throw new Error("头像地址无效。");
      await ensure();
      signal.throwIfAborted();
      const name = await filename(key),
        path = `${directory}/${name}`;
      if (files.has(name)) {
        files.get(name)!.used = Date.now();
        return mediaResourceUrl(`${prefix}/${name}`);
      }
      const incoming = await download(url, IMAGE_BYTES, signal);
      try {
        const header = new Uint8Array(
          await filesystem.readBinaryFile(incoming.temporary, { pos: 0, size: 3 }),
        );
        if (header[0] !== 255 || header[1] !== 216 || header[2] !== 255)
          throw new Error("头像不是有效 JPEG。");
        const save = commit.then(async () => {
          signal.throwIfAborted();
          // 同一个地址的并发请求只保留一份缓存。
          if (files.has(name)) return;
          await prune(incoming.bytes);
          await filesystem.move(incoming.temporary, path);
          files.set(name, { bytes: incoming.bytes, used: Date.now() });
        });
        commit = save.catch(() => {});
        await save;
        return mediaResourceUrl(`${prefix}/${name}`);
      } finally {
        await incoming.cleanup();
      }
    },
    async index(signal) {
      await ensure();
      signal.throwIfAborted();
      const path = `${directory}/gfriends-index.json`;
      // 索引只在需要兜底时读取；已有索引可离线复用，不在每次启动下载。
      const cached = await readIndex(path).catch(() => null);
      if (cached) return cached;
      for (const url of gfriendsIndexSources) {
        try {
          const incoming = await download(url, INDEX_BYTES, signal);
          try {
            const json = await readIndex(incoming.temporary);
            signal.throwIfAborted();
            await filesystem.move(incoming.temporary, path);
            return json;
          } finally {
            await incoming.cleanup();
          }
        } catch {
          signal.throwIfAborted();
        }
      }
      throw new Error("备用头像索引暂不可用。");
    },
    async invalidateIndex() {
      if (directory) await filesystem.remove(`${directory}/gfriends-index.json`).catch(() => {});
    },
    async shutdown() {
      await commit;
      for (const retry of pendingStops) {
        await retry();
        pendingStops.delete(retry);
      }
      await ready?.catch(() => {});
      if (mounted) {
        await server.unmount(prefix);
        mounted = false;
      }
    },
  };
}
