import { filesystem } from "@neutralinojs/lib";
import { yieldToUi } from "../../services/yieldToUi";

export function mediaResourceUrl(path: string) {
  const origin =
    location.port === String(window.NL_PORT)
      ? location.origin
      : `http://127.0.0.1:${window.NL_PORT}`;
  return `${origin}${path}`;
}

export async function readPlaybackCache(path: string, url: string, signal: AbortSignal) {
  if (location.port === String(window.NL_PORT)) {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("无法读取视频分片缓存。");
    return response.arrayBuffer();
  }
  // Vite 开发页面与宿主不同源。官方二进制 API 按 256 KiB 读取并让出 UI，
  // 限制客户端库每次 Base64 解码工作量；发布版使用同源二进制传输。
  const stats = await filesystem.getStats(path);
  if (stats.size > 67108864) throw new Error("视频分片超过缓存大小限制。");
  const bytes = new Uint8Array(stats.size);
  for (let position = 0; position < bytes.length;) {
    signal.throwIfAborted();
    const chunk = await filesystem.readBinaryFile(path, {
      pos: position,
      size: Math.min(262144, bytes.length - position),
    });
    if (!chunk.byteLength) throw new Error("视频分片读取不完整。");
    bytes.set(new Uint8Array(chunk), position);
    position += chunk.byteLength;
    await yieldToUi();
  }
  return bytes.buffer;
}
