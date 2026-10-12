import { filesystem, os } from "@neutralinojs/lib";
import { CATALOG_BYTES } from "../../services/catalog/catalogData";
import { isAvwikiWorksUrl } from "../../services/catalog/avwikiWorks";
import { isJavbusWorksUrl } from "../../services/catalog/javbusWorks";
import {
  isJavbusFetchUrl,
  requestJavbusWithRedirects,
} from "../../services/catalog/javbusRedirects";
import type { HttpRequest } from "../../services/network/HttpService";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { logEvent } from "../../services/logging/events";
import { requestHttp } from "./http";

export type CatalogBrowserFetch = (
  url: string,
  signal: AbortSignal,
  proxy: string,
) => Promise<string>;

export function createCatalogHttp(
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
  browserFetch?: CatalogBrowserFetch,
) {
  return async (url: string, signal: AbortSignal) => {
    const parsed = new URL(url);
    const works = isAvwikiWorksUrl(url);
    const javbus = isJavbusFetchUrl(url);
    const subject = works || isJavbusWorksUrl(url) ? "作品" : "名单";
    const actorDirectory =
      parsed.origin === "https://avwikidb.com" &&
      !parsed.username &&
      !parsed.password &&
      /^\/(actor|histrion|director|maker|series)\/$/.test(parsed.pathname) &&
      (!parsed.search || /^\?page=(?:[1-9]\d{0,2}|1000)$/.test(parsed.search)) &&
      !parsed.hash;
    if (!actorDirectory && !works && !javbus) throw new Error(`${subject}来源地址无效。`);
    let directory = "",
      deferCleanup = false;
    const cleanup = async () => {
      if (directory) await filesystem.remove(directory).catch(() => {});
    };
    try {
      await beforeFetch();
      signal.throwIfAborted();
      const proxy = await network.getProxy();
      signal.throwIfAborted();
      directory = `${await os.getPath("temp")}/javm-catalog-${crypto.randomUUID()}`;
      await filesystem.createDirectory(directory);
      const response = `${directory}/response`;
      const avwiki = parsed.origin === "https://avwikidb.com";
      const headers = avwiki
        ? [
            "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language: ja,en;q=0.8",
            `Referer: ${parsed.origin}/`,
            `User-Agent: ${navigator.userAgent}`,
            "Sec-Fetch-Dest: document",
            "Sec-Fetch-Mode: navigate",
            "Sec-Fetch-Site: same-origin",
            "Upgrade-Insecure-Requests: 1",
          ]
        : [
            "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language: zh-CN,zh;q=0.9",
            `Referer: ${parsed.origin}/`,
          ];
      const request: HttpRequest = {
        purpose: "catalog",
        url,
        proxy,
        output: response,
        headers: Object.fromEntries(
          headers.map((header) => {
            const colon = header.indexOf(":");
            return [header.slice(0, colon), header.slice(colon + 1).trim()];
          }),
        ),
        maxBytes: CATALOG_BYTES,
        timeoutMs: 25_000,
        // 目录与作品服务已有缓存；手动刷新必须真实读取，403 不缓存。
      };
      const result = javbus
        ? await requestJavbusWithRedirects(request, signal, requestHttp, (diagnostic) => {
            logEvent(
              diagnostic.reason === "follow" ? "info" : "warn",
              "catalog",
              "javbus_redirect",
              diagnostic.reason === "follow" ? "JavBus 正在跟随站内跳转" : "JavBus 跳转已结束",
              { source: "javbus", subject, ...diagnostic },
            );
          })
        : await requestHttp(request, signal);
      signal.throwIfAborted();
      const status = result.status;
      // 不输出 stderr、网页、URL、Cookie 或代理地址，只记录固定阶段和数字状态。
      const diagnostic = {
        source: avwiki ? "avwikidb" : "javbus",
        subject,
        exitCode: result.exitCode,
        status,
        proxyEnabled: !!proxy,
      };
      if (result.exitCode) {
        logEvent("warn", "catalog", "http_failed", `${subject}网络请求失败`, diagnostic);
        const reason: Record<number, string> = {
          5: "代理地址解析失败",
          6: "来源域名解析失败",
          7: "无法连接来源或代理",
          23: "临时文件写入失败",
          28: "读取超时",
          35: "HTTPS 握手失败",
          60: "HTTPS 证书校验失败",
          63: "响应超过大小限制",
          97: "代理握手失败",
        };
        throw new Error(
          `${subject}${reason[result.exitCode] ?? "请求失败"}（curl ${result.exitCode}）。${result.exitCode === 35 ? "请检查系统设置中的网络代理。" : "请稍后重试。"}`,
        );
      }
      if (status === 403 && works && browserFetch) {
        logEvent(
          "info",
          "catalog",
          "browser_fallback",
          "作品请求被拒绝，正在使用隐藏浏览器读取",
          diagnostic,
        );
        const html = await browserFetch(url, signal, proxy);
        signal.throwIfAborted();
        logEvent("info", "catalog", "browser_completed", "隐藏浏览器已完成作品读取并退出");
        return html;
      }
      if (status !== 200) {
        logEvent("warn", "catalog", "http_rejected", `${subject}来源未返回正常响应`, diagnostic);
        if (status === 403)
          throw new Error(`${subject}来源拒绝访问（HTTP 403），请检查代理线路或稍后重试。`);
        if (status === 401) throw new Error(`${subject}来源要求登录（HTTP 401），已结束读取。`);
        if (status >= 300 && status < 400)
          throw new Error(`${subject}来源返回重定向（HTTP ${status}），已结束读取。`);
        if (status === 429) throw new Error(`${subject}来源请求过于频繁（HTTP 429），请稍后重试。`);
        throw new Error(`${subject}来源响应异常（HTTP ${status}），已保留当前结果。`);
      }
      const stats = await filesystem.getStats(response);
      if (!stats.isFile || stats.size > CATALOG_BYTES)
        throw new Error(`${subject}响应过大，已保留当前结果。`);
      const html = await filesystem.readFile(response);
      signal.throwIfAborted();
      return html;
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        deferCleanup = true;
        throw new StopUnconfirmedError(async () => {
          await error.retry();
          await cleanup();
        });
      }
      throw error;
    } finally {
      if (!deferCleanup) await cleanup();
    }
  };
}
