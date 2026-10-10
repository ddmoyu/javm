import { filesystem, os } from "@neutralinojs/lib";
import type { ResolutionHttpPort } from "../../services/streamResolution/ports";
import {
  bounds,
  check,
  normalizeRequest,
  ResolutionError,
} from "../../services/streamResolution/shared";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { findOnPath, runNativeProcess } from "./process";

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
function responseHeaders(body: ArrayBuffer, expectedStatus: number) {
  const blocks = new TextDecoder()
    .decode(body)
    .trim()
    .split(/\r?\n\r?\n/);
  const block = blocks.filter((item) => /^HTTP\/\S+ \d{3}\b/.test(item)).at(-1);
  if (!block || Number(/^HTTP\/\S+ (\d{3})/.exec(block)?.[1]) !== expectedStatus)
    throw new ResolutionError("network_error");
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(":");
    if (index < 1) continue;
    const name = line.slice(0, index).toLowerCase();
    // 不将 Set-Cookie、服务器诊断或其他无关文本交给解析层。
    if (
      !["location", "content-type", "content-range", "content-length", "content-encoding"].includes(
        name,
      )
    )
      continue;
    if (name in headers) throw new ResolutionError("parse_failed", true);
    headers[name] = line.slice(index + 1).trim();
  }
  return headers;
}

export function createResolutionHttp(): ResolutionHttpPort {
  let verifiedCurl = "";
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
    if (!verifiedCurl) {
      const curl = await findOnPath("curl.exe");
      check(signal);
      if (!curl) throw new ResolutionError("unavailable");
      const version = await runNativeProcess(
        curl,
        ["--disable", "--version"],
        signal,
        undefined,
        true,
      );
      check(signal);
      const parts = /^curl (\d+)\.(\d+)\./.exec(version.stdOut);
      // 8.4.0 起 --max-filesize 对未知长度响应也会在传输中中断。
      if (
        version.exitCode ||
        !parts ||
        Number(parts[1]) < 8 ||
        (Number(parts[1]) === 8 && Number(parts[2]) < 4)
      )
        throw new ResolutionError("unavailable");
      verifiedCurl = curl;
    }
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
      await filesystem.writeFile(
        `${directory}/request-headers`,
        Object.entries(normalized.headers ?? {})
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n"),
      );
      const args = [
        "--disable",
        "--globoff",
        "--silent",
        "--show-error",
        "--proto",
        "=http,https",
        "--connect-timeout",
        String(Math.min(5, request.timeoutMs / 1000)),
        "--max-time",
        String(request.timeoutMs / 1000),
        "--max-filesize",
        String(request.maxBytes),
        "--proxy",
        request.proxy,
        "--noproxy",
        request.proxy ? "" : "*",
        "--header",
        `@${directory}/request-headers`,
        "--header",
        "Accept-Encoding: identity",
        "--dump-header",
        `${directory}/response-headers`,
        "--output",
        `${directory}/body`,
        "--write-out",
        "%{http_code}",
      ];
      if (range) args.push("--range", `${range.start}-${range.start + range.length - 1}`);
      args.push("--url", normalized.url);
      // 无 --location 或 --retry：每一跳、每次重试均由有预算的会话控制。
      const result = await runNativeProcess(verifiedCurl, args, signal, undefined, true);
      check(signal);
      if (result.exitCode)
        throw new ResolutionError(
          result.exitCode === 63
            ? "limit_exceeded"
            : result.exitCode === 28
              ? "timeout"
              : "network_error",
        );
      const status = Number(result.stdOut.trim());
      const headers = responseHeaders(
        await readBounded(`${directory}/response-headers`, 64 * 1024, signal),
        status,
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
