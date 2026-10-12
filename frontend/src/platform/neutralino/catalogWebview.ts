import { readAvwikiBrowserPage } from "../../services/catalog/avwikiBrowser";
import type {
  AvwikiBrowserDiagnostics,
  AvwikiBrowserStage,
} from "../../services/catalog/avwikiBrowser";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { ResolutionError } from "../../services/streamResolution/shared";
import { logEvent } from "../../services/logging/events";
import { HiddenWebviewError, withHiddenWebview } from "./hiddenWebview";
import type { HiddenWebviewStage } from "./hiddenWebview";
import {
  CatalogBrowserError,
  CatalogReadCancellation,
} from "../../services/catalog/browserDiagnostics";
import { logCatalogBrowserDiagnostics } from "./catalogDiagnostics";

export async function fetchCatalogWithWebview(url: string, signal: AbortSignal, proxy: string) {
  let stage: AvwikiBrowserStage = "initializing";
  let status = 0;
  let challenge = false;
  let diagnostic: AvwikiBrowserDiagnostics | undefined;
  const attempt = crypto.randomUUID().slice(0, 8);
  const started = performance.now();
  let phase: HiddenWebviewStage = "launch";
  let reason = "success",
    code = "";
  logEvent("info", "catalog", "browser_started", "隐藏作品读取开始", {
    attempt,
    adapterRevision: 10,
    proxyEnabled: !!proxy,
  });
  try {
    return await withHiddenWebview(
      signal,
      proxy,
      (cdp, boundedSignal) => {
        phase = "read";
        return readAvwikiBrowserPage(
          cdp,
          url,
          boundedSignal,
          (response) => {
            status = response.status;
            challenge = response.challenge;
            logEvent("info", "catalog", "browser_response", "隐藏作品页面响应", {
              attempt,
              status,
              challenge,
            });
          },
          (value) => {
            stage = value;
            logEvent("info", "catalog", "browser_page_stage", "隐藏作品读取阶段", {
              attempt,
              stage,
              status,
              challenge,
            });
          },
          (value) => {
            diagnostic = value;
            logCatalogBrowserDiagnostics(attempt, value);
          },
        );
      },
      (value) => {
        phase = value;
        logEvent("info", "catalog", "browser_host_stage", "隐藏浏览器运行阶段", {
          attempt,
          phase,
          adapterRevision: 10,
        });
      },
    );
  } catch (error) {
    if (error instanceof HiddenWebviewError) phase = error.stage;
    if (error instanceof StopUnconfirmedError) {
      reason = "cleanup_unconfirmed";
      throw error;
    }
    if (signal.aborted) {
      reason = "cancelled";
      code =
        signal.reason instanceof CatalogReadCancellation ? signal.reason.reason : "caller_aborted";
    } else if (error instanceof CatalogBrowserError) {
      reason = error.reason;
    } else if (error instanceof ResolutionError) {
      code = error.code;
      reason =
        error.code === "timeout"
          ? "timeout"
          : diagnostic?.detail?.lastCdpCommand
            ? "cdp_error"
            : "host_error";
    } else reason = "unexpected_error";
    signal.throwIfAborted();
    if (error instanceof ResolutionError) {
      const phase = error instanceof HiddenWebviewError ? error.stage : "read";
      logEvent("warn", "catalog", "browser_failed", "隐藏作品读取未完成", {
        phase,
        stage,
        status,
        challenge,
        code: error.code,
        failedResources: diagnostic?.failedResources ?? 0,
        canceledResources: diagnostic?.canceledResources ?? 0,
        blockedResources: diagnostic?.blockedResources ?? 0,
      });
      if (error.code === "timeout") {
        if (phase === "launch")
          throw new Error("隐藏浏览器启动超时，尚未开始读取作品来源，已自动退出。");
        if (phase === "connect")
          throw new Error("隐藏浏览器的本地控制连接超时，尚未开始读取作品来源，已自动退出。");
        if (challenge && diagnostic?.failedResources)
          throw new Error(
            `作品来源的自动验证未能在时限内完成（HTTP ${status}），期间记录到子请求异常（${diagnostic.lastNetworkError}），已自动结束隐藏读取。`,
          );
        if (challenge && diagnostic?.scriptErrors)
          throw new Error(
            `作品来源的自动验证未能在时限内完成（HTTP ${status}），期间记录到页面脚本异常，已自动结束隐藏读取。`,
          );
        if (challenge)
          throw new Error(
            `作品来源的自动验证未能在时限内完成（HTTP ${status}），已自动结束隐藏读取。`,
          );
        if (status === 200)
          throw new Error("作品页面已返回，但未能在时限内读取到作品内容，已自动结束隐藏读取。");
        if (stage === "initializing")
          throw new Error("隐藏浏览器初始化超时，尚未开始读取作品来源，已自动退出。");
        throw new Error(
          "隐藏浏览器未能在时限内收到作品页面响应，请检查代理线路，已自动结束隐藏读取。",
        );
      }
      if (error.code === "invalid_input")
        throw new Error(
          "当前代理配置不能用于隐藏浏览器，请使用不含账号密码的本地 HTTP 或 SOCKS5 代理。",
        );
      throw new Error("隐藏浏览器未能读取作品，请检查 WebView2 和代理配置后重试。");
    }
    throw error;
  } finally {
    logEvent(
      reason === "success" || reason === "cancelled" ? "info" : "warn",
      "catalog",
      "browser_finished",
      "隐藏作品读取结束",
      {
        attempt,
        reason,
        phase,
        stage,
        status,
        challenge,
        elapsedMs: Math.round(performance.now() - started),
        code,
      },
    );
  }
}
