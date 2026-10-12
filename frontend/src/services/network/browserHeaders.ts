import type { HttpRequest } from "./HttpService";

/** 使用当前 WebView 的真实标识；不虚构 Chrome 版本、客户端提示或登录状态。 */
export function browserHeaders(
  request: HttpRequest,
  browser: Pick<Navigator, "userAgent" | "languages" | "language">,
): Record<string, string> {
  const languages = [...new Set([...(browser.languages ?? []), browser.language])]
    .filter((value) => typeof value === "string" && /^[A-Za-z0-9-]{1,40}$/.test(value))
    .slice(0, 3);
  const accepts: Record<HttpRequest["purpose"], string> = {
    catalog: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    portrait: "image/avif,image/webp,image/jpeg,image/*;q=0.9,*/*;q=0.8",
    artwork: "image/avif,image/webp,image/jpeg,image/*;q=0.9,*/*;q=0.8",
    metadata: "application/json",
    resolution: "*/*",
    proxy: "*/*",
  };
  const headers = new Map(
    Object.entries({
      "User-Agent": browser.userAgent || "JAVM",
      Accept: accepts[request.purpose],
      "Accept-Language": languages.length
        ? languages
            .map((value, index) => `${value}${index ? `;q=${(1 - index / 10).toFixed(1)}` : ""}`)
            .join(",")
        : "en",
      // 当前内置模块不链接解压库，不能承诺接受 gzip、br、zstd。
      "Accept-Encoding": "identity",
    }).map(([name, value]) => [name.toLowerCase(), [name, value]]),
  );
  // 调用方请求头多已规范为小写；HTTP/1.1 浏览器发送标准大小写，部分 CDN 据此拦截小写名。
  for (const [name, value] of Object.entries(request.headers ?? {}))
    headers.set(name.toLowerCase(), [
      name
        .toLowerCase()
        .replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => dash + letter.toUpperCase()),
      value,
    ]);
  return Object.fromEntries(headers.values());
}
