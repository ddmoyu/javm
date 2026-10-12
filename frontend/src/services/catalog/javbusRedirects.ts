import type { HttpRequest, HttpResponse } from "../network/HttpService";
import { hasControlCharacters } from "./avwikiCsv";
import { isJavbusCatalogUrl, JAVBUS_ORIGIN } from "./javbusWorks";

const hosts = new Set(["www.javbus.com", "javbus.com"]);
const redirects = new Set([301, 302, 303, 307, 308]);
export type JavbusRedirectReason =
  | "follow"
  | "missing_location"
  | "ambiguous_location"
  | "invalid_location"
  | "untrusted_target"
  | "verification"
  | "unsupported_path"
  | "identity_changed"
  | "loop"
  | "limit"
  | "timeout"
  | "size_limit"
  | "unexpected_final";
export interface JavbusRedirectDiagnostic {
  status: number;
  hop: number;
  reason: JavbusRedirectReason;
  upgradedHttps: boolean;
}
const messages: Record<Exclude<JavbusRedirectReason, "follow">, string> = {
  missing_location: "未提供跳转地址",
  ambiguous_location: "跳转响应头不明确",
  invalid_location: "跳转地址无效",
  untrusted_target: "跳转目标不属于允许的来源",
  verification: "跳转到验证或登录入口，无法自动完成",
  unsupported_path: "跳转到暂不支持的页面",
  identity_changed: "跳转后的作品或目录与请求不一致",
  loop: "出现循环跳转",
  limit: "跳转次数超过上限",
  timeout: "跳转读取超时",
  size_limit: "跳转响应总量超过限制",
  unexpected_final: "实际响应地址与请求不一致",
};
export class JavbusRedirectError extends Error {
  constructor(readonly diagnostic: JavbusRedirectDiagnostic) {
    super(
      `JavBus ${messages[diagnostic.reason as Exclude<JavbusRedirectReason, "follow">]}${diagnostic.status ? `（HTTP ${diagnostic.status}）` : ""}，已结束读取。`,
    );
    this.name = "JavbusRedirectError";
  }
}
function parseUrl(value: string, base?: string) {
  if (
    !value ||
    value.length > 4096 ||
    hasControlCharacters(value) ||
    /\\|%(?:00|2f|5c)/i.test(value)
  )
    return;
  try {
    return new URL(value, base);
  } catch {
    return;
  }
}
function trusted(url: URL) {
  return (
    hosts.has(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    ["https:", "http:"].includes(url.protocol)
  );
}
function logicalUrl(url: URL) {
  const normalized = new URL(url.href);
  normalized.protocol = "https:";
  normalized.hostname = new URL(JAVBUS_ORIGIN).hostname;
  if (normalized.pathname !== "/") normalized.pathname = normalized.pathname.replace(/\/$/, "");
  normalized.hash = "";
  return normalized;
}
// 只接受同一实体、作品、搜索词和页号。规范化不能把数字来源 ID 当成页号。
function identity(url: URL) {
  const normalized = logicalUrl(url);
  let path = decodeURIComponent(normalized.pathname).normalize("NFC");
  path = path.replace(/(\/(?:star|studio|label|series|director|genre)\/[^/]+)\/1$/, "$1");
  path = path.replace(/(\/(?:searchstar|search)\/[^/]+|\/(?:uncensored\/)?actresses)\/1$/, "$1");
  if (path === "/page/1") path = "/";
  if (path === "/uncensored/page/1") path = "/uncensored";
  if (/^\/(?:uncensored\/)?(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{2,100}$/i.test(path))
    path = path.toUpperCase();
  return path;
}
export function isJavbusFetchUrl(value: string) {
  const url = parseUrl(value);
  return (
    !!url &&
    trusted(url) &&
    url.protocol === "https:" &&
    !url.hash &&
    isJavbusCatalogUrl(logicalUrl(url).href)
  );
}

/** 每一跳都重新经过 HTTP 调度器，保留限频、取消和文件清理，不开启 libcurl 无条件跟随。 */
export async function requestJavbusWithRedirects(
  request: HttpRequest,
  signal: AbortSignal,
  execute: (request: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>,
  report: (diagnostic: JavbusRedirectDiagnostic) => void = () => {},
): Promise<HttpResponse> {
  if (!isJavbusFetchUrl(request.url) || (request.method && request.method !== "GET"))
    throw new Error("JavBus 作品来源地址无效。");
  const original = new URL(request.url);
  const expected = identity(original);
  const deadline = Date.now() + request.timeoutMs;
  const visited = new Set<string>();
  let current = original.href,
    bytes = 0;
  const fail = (
    reason: Exclude<JavbusRedirectReason, "follow">,
    status: number,
    hop: number,
  ): never => {
    const diagnostic = { reason, status, hop, upgradedHttps: false };
    report(diagnostic);
    throw new JavbusRedirectError(diagnostic);
  };
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("timeout", 0, hop);
    if (bytes >= request.maxBytes) fail("size_limit", 0, hop);
    visited.add(current);
    const headers =
      new URL(current).origin === original.origin
        ? request.headers
        : Object.fromEntries(
            Object.entries(request.headers ?? {}).filter(
              ([name]) =>
                !["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase()),
            ),
          );
    const result = await execute(
      {
        ...request,
        url: current,
        headers,
        maxRedirects: 0,
        cacheTtlMs: 0,
        timeoutMs: remaining,
        connectTimeoutMs: Math.min(request.connectTimeoutMs ?? 5000, remaining),
        maxBytes: request.maxBytes - bytes,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.exitCode) return result;
    if (
      !Number.isSafeInteger(result.bytes) ||
      result.bytes < 0 ||
      result.bytes > request.maxBytes - bytes
    )
      fail("size_limit", result.status, hop);
    bytes += result.bytes;
    if (Date.now() >= deadline) fail("timeout", result.status, hop);
    const effective = parseUrl(result.effectiveUrl);
    if (!effective || effective.href !== current) fail("unexpected_final", result.status, hop);
    if (!redirects.has(result.status)) return result;
    if (result.ambiguousHeaders) fail("ambiguous_location", result.status, hop);
    const location = result.headers.location;
    if (!location) return fail("missing_location", result.status, hop);
    const target = parseUrl(location, current);
    if (!target) return fail("invalid_location", result.status, hop);
    if (!trusted(target)) fail("untrusted_target", result.status, hop);
    if (
      /\/(?:[^/]*(?:age[-_]?check|age[-_]?verify|age[-_]?verification|age[-_]?gate|verify|captcha|challenge)[^/]*|age|login|signin|auth)(?:\/|$)/i.test(
        target.pathname,
      ) ||
      /\/cdn-cgi\//i.test(target.pathname)
    )
      fail("verification", result.status, hop);
    const upgradedHttps = target.protocol === "http:";
    // 实测来源的斜杠规范化会返回同站 HTTP Location；只改用其 HTTPS 等价地址。
    target.protocol = "https:";
    target.hash = "";
    if (!isJavbusFetchUrl(target.href)) fail("unsupported_path", result.status, hop);
    if (identity(target) !== expected) fail("identity_changed", result.status, hop);
    if (visited.has(target.href)) fail("loop", result.status, hop);
    if (hop >= 3) fail("limit", result.status, hop);
    report({ reason: "follow", status: result.status, hop: hop + 1, upgradedHttps });
    current = target.href;
  }
}
