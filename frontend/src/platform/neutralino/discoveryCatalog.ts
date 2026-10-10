import { filesystem, os, storage } from "@neutralinojs/lib";
import { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import { CatalogWorkerClient } from "../../services/catalog/workerClient";
import { CATALOG_BYTES } from "../../services/catalog/catalogData";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { findOnPath, runNativeProcess } from "./process";
import type { Runtime } from "./bootstrap";
import { PortraitService } from "../../services/catalog/PortraitService";
import { createPortraitPort } from "./portraits";

const CACHE_KEY = "javm-discovery-catalog-v4";
export function createDiscoveryCatalogService(
  runtime: Runtime,
  network: NetworkSettingsService,
  beforeFetch: () => Promise<unknown>,
) {
  let curl: Promise<string> | undefined;
  const processor = new CatalogWorkerClient();
  const service = new DiscoveryCatalogService(
    processor,
    runtime === "desktop" && import.meta.env.PROD
      ? {
          async read() {
            try {
              const keys = await storage.getKeys();
              const key = keys.includes(CACHE_KEY)
                ? CACHE_KEY
                : keys.includes("javm-discovery-catalog-v3")
                  ? "javm-discovery-catalog-v3"
                  : keys.includes("javm-discovery-catalog-v2")
                    ? "javm-discovery-catalog-v2"
                    : "javm-genre-catalog-v1";
              return keys.includes(key) ? await storage.getData(key) : null;
            } catch (error) {
              if ((error as { code?: string }).code === "NE_ST_NOSTDIR") return null;
              throw new Error("名单缓存读取失败，继续使用内置名单。");
            }
          },
          async write(cache: string) {
            await storage.setData(CACHE_KEY, cache);
          },
          async fetch(url: string, signal: AbortSignal) {
            const parsed = new URL(url);
            const actorDirectory =
              parsed.origin === "https://avwikidb.com" &&
              /^\/(actor|histrion|director|maker|series)\/$/.test(parsed.pathname) &&
              (!parsed.search ||
                /^\?page=[1-9]\d{0,2}$/.test(parsed.search) ||
                parsed.search === "?page=1000") &&
              !parsed.hash;
            if (
              !actorDirectory &&
              (parsed.origin !== "https://www.javbus.com" ||
                parsed.search ||
                parsed.hash ||
                !/^\/(?:uncensored(?:\/genre|\/page\/[1-9]\d{0,5})?|genre|page\/[1-9]\d{0,5}|[a-z0-9][a-z0-9_-]{2,100})?$/i.test(
                  parsed.pathname,
                ))
            )
              throw new Error("名单来源地址无效。");
            const maxBytes = CATALOG_BYTES;
            let directory = "";
            let deferCleanup = false;
            const cleanup = async () => {
              if (directory) await filesystem.remove(directory).catch(() => {});
            };
            try {
              await beforeFetch();
              signal.throwIfAborted();
              const executable = await (curl ??= findOnPath("curl.exe"));
              if (!executable) throw new Error("找不到系统 curl，继续使用本地名单。");
              const proxy = await network.getProxy();
              signal.throwIfAborted();
              directory = `${await os.getPath("temp")}/javm-catalog-${crypto.randomUUID()}`;
              await filesystem.createDirectory(directory);
              const response = `${directory}/response`;
              const result = await runNativeProcess(
                executable,
                [
                  "--disable",
                  "--silent",
                  "--show-error",
                  "--connect-timeout",
                  "5",
                  "--max-time",
                  "25",
                  "--max-filesize",
                  String(maxBytes),
                  "--proto",
                  "=https",
                  "--proxy",
                  proxy,
                  "--noproxy",
                  "",
                  "--header",
                  "Accept: text/html",
                  "--header",
                  "Accept-Language: zh-CN,zh;q=0.9",
                  "--output",
                  response,
                  "--write-out",
                  "%{http_code}",
                  // 不跟随验证重定向、不提交年龄声明，也不记录网页正文或 Cookie。
                  "--url",
                  url,
                ],
                signal,
                undefined,
                true,
              );
              signal.throwIfAborted();
              if (result.exitCode !== 0)
                throw new Error(
                  result.exitCode === 28
                    ? "名单更新超时，继续使用本地名单。"
                    : "名单来源暂时不可用，继续使用本地名单。",
                );
              const status = Number(result.stdOut.trim());
              if ((status >= 300 && status < 400) || status === 401 || status === 403)
                throw new Error(`名单来源要求验证或重定向（HTTP ${status}），已保留本地名单。`);
              if (status !== 200) throw new Error("名单来源响应异常，已保留本地名单。");
              const stats = await filesystem.getStats(response);
              if (!stats.isFile || stats.size > maxBytes)
                throw new Error("名单响应过大，已保留本地名单。");
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
          },
        }
      : undefined,
    runtime === "desktop" && import.meta.env.PROD
      ? new PortraitService(processor, createPortraitPort(network, beforeFetch))
      : undefined,
  );
  void service.initialize();
  return service;
}
