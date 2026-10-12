import { filesystem, os } from "@neutralinojs/lib";
import type { ResolutionHttpPort } from "../../services/streamResolution/ports";
import {
  bounds,
  check,
  normalizeRequest,
  ResolutionError,
} from "../../services/streamResolution/shared";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { requestHttp } from "./http";

async function readBounded(path: string, max: number, signal: AbortSignal) {
  check(signal);
  const stat = await filesystem.getStats(path);
  if (!stat.isFile || stat.size < 0 || stat.size > max) throw new ResolutionError("limit_exceeded");
  const bytes = new Uint8Array(stat.size);
  for (let offset = 0; offset < stat.size; offset += 64 * 1024) {
    check(signal);
    const length = Math.min(64 * 1024, stat.size - offset);
    const chunk = await filesystem.readBinaryFile(path, { pos: offset, size: length });
    if (chunk.byteLength !== length) throw new ResolutionError("network_error");
    bytes.set(new Uint8Array(chunk), offset);
    // 官方文件 API 的 Base64 解码亦在主线程；分块并让出事件循环。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check(signal);
  return bytes.buffer;
}
export function createResolutionHttp(): ResolutionHttpPort {
  return async (request, signal) => {
    check(signal);
    const normalized = normalizeRequest({
      url: request.url,
      headers: request.headers,
      provider: "direct-hls",
    });
    const hostname = new URL(normalized.url).hostname.replace(/\.$/, "");
    // 测试域必须由 fixture transport 响应，禁止意外落到真实网络适配器。
    if (hostname === "invalid" || hostname.endsWith(".invalid"))
      throw new ResolutionError("invalid_input");
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes <= 0 ||
      request.maxBytes > bounds.pageBytes ||
      !Number.isFinite(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      request.timeoutMs > bounds.requestMs
    )
      throw new ResolutionError("invalid_input");
    const range = request.range;
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        range.start < 0 ||
        !Number.isSafeInteger(range.length) ||
        range.length <= 0 ||
        range.length > request.maxBytes ||
        !Number.isSafeInteger(range.start + range.length))
    )
      throw new ResolutionError("invalid_input");
    const directory = `${await os.getPath("temp")}/javm-resolution-${crypto.randomUUID()}`;
    check(signal);
    await filesystem.createDirectory(directory);
    let deferred = false;
    const cleanup = async () => {
      try {
        await filesystem.remove(directory);
      } catch (error) {
        if ((error as { code?: string }).code !== "NE_FS_NOPATHE")
          throw new StopUnconfirmedError(cleanup);
      }
    };
    try {
      check(signal);
      // 每一跳、每次重试均由有预算的会话控制。
      const result = await requestHttp(
        {
          purpose: "resolution",
          url: normalized.url,
          proxy: request.proxy,
          output: `${directory}/body`,
          maxBytes: request.maxBytes,
          timeoutMs: request.timeoutMs,
          headers: {
            ...normalized.headers,
            "Accept-Encoding": "identity",
            ...(range ? { Range: `bytes=${range.start}-${range.start + range.length - 1}` } : {}),
          },
        },
        signal,
      );
      check(signal);
      if (result.exitCode)
        throw new ResolutionError(
          result.exitCode === 63
            ? "limit_exceeded"
            : result.exitCode === 28
              ? "timeout"
              : "network_error",
        );
      const status = result.status;
      if (result.ambiguousHeaders) throw new ResolutionError("parse_failed", true);
      const headers = Object.fromEntries(
        Object.entries(result.headers).filter(([name]) =>
          [
            "location",
            "content-type",
            "content-range",
            "content-length",
            "content-encoding",
          ].includes(name),
        ),
      );
      const body = await readBounded(`${directory}/body`, request.maxBytes, signal);
      return { status, headers, body };
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        deferred = true;
        throw new StopUnconfirmedError(async () => {
          await error.retry();
          await cleanup();
        });
      }
      throw error;
    } finally {
      if (!deferred) await cleanup();
    }
  };
}
