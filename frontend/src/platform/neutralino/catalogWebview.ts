import { readAvwikiBrowserPage } from "../../services/catalog/avwikiBrowser";
import type { AvwikiBrowserStage } from "../../services/catalog/avwikiBrowser";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { ResolutionError } from "../../services/streamResolution/shared";
import { logEvent } from "../../services/logging/events";
import { HiddenWebviewError, withHiddenWebview } from "./hiddenWebview";

export async function fetchCatalogWithWebview(url: string, signal: AbortSignal, proxy: string) {
  let stage: AvwikiBrowserStage = "initializing";
  let status = 0;
  let challenge = false;
  try {
    return await withHiddenWebview(
      signal,
      proxy,
      (cdp, boundedSignal) =>
        readAvwikiBrowserPage(
          cdp,
          url,
          boundedSignal,
          (response) => {
            status = response.status;
            challenge = response.challenge;
            logEvent("info", "catalog", "browser_response", "隐藏作品页面响应", {
              status,
              challenge,
            });
          },
          (value) => {
            stage = value;
            logEvent("info", "catalog", "browser_page_stage", "隐藏作品读取阶段", {
              stage,
              status,
              challenge,
            });
          },
        ),
      (phase) =>
        logEvent("info", "catalog", "browser_host_stage", "隐藏浏览器运行阶段", {
          phase,
          adapterRevision: 3,
        }),
    );
  } catch (error) {
    if (error instanceof StopUnconfirmedError) throw error;
    signal.throwIfAborted();
    if (error instanceof ResolutionError) {
      const phase = error instanceof HiddenWebviewError ? error.stage : "read";
      logEvent("warn", "catalog", "browser_failed", "隐藏作品读取未完成", {
        phase,
        stage,
        status,
        challenge,
        code: error.code,
      });
      if (error.code === "timeout") {
        if (phase === "launch")
          throw new Error("隐藏浏览器启动超时，尚未开始读取作品来源，已自动退出。");
        if (phase === "connect")
          throw new Error("隐藏浏览器的本地控制连接超时，尚未开始读取作品来源，已自动退出。");
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
  }
}
