import type { AvwikiBrowserDiagnostics } from "../../services/catalog/avwikiBrowser";
import { logEvent } from "../../services/logging/events";

export function logCatalogBrowserDiagnostics(attempt: string, value: AvwikiBrowserDiagnostics) {
  // 每条最多 8 个字段；只接收经过枚举、数值和布尔校验的诊断。
  logEvent("info", "catalog", "browser_resources", "隐藏作品读取网络统计", {
    attempt,
    requests: value.requests,
    scriptErrors: value.scriptErrors,
    failedResources: value.failedResources,
    lastResourceType: value.lastResourceType,
    lastNetworkError: value.lastNetworkError,
  });
  logEvent("info", "catalog", "browser_targets", "隐藏作品读取子目标统计", {
    attempt,
    workers: value.workers,
    resumedWorkers: value.resumedWorkers,
    activePages: value.activePages,
  });
  logEvent("info", "catalog", "browser_cancellations", "隐藏作品读取取消统计", {
    attempt,
    canceledResources: value.canceledResources,
    blockedResources: value.blockedResources,
    lastCanceledType: value.lastCanceledType,
    lastCanceledSource: value.lastCanceledSource,
    lastCanceledAfterMs: value.lastCanceledAfterMs,
    lastFailureSource: value.lastFailureSource,
    lastFailureAfterMs: value.lastFailureAfterMs,
  });
  logEvent("info", "catalog", "browser_verification", "隐藏作品读取验证统计", {
    attempt,
    pat401Responses: value.pat401Responses,
    blockedChallengeResources: value.blockedChallengeResources,
    blockedResourceTypes: value.blockedResourceTypes,
    interaction: value.challengeInteraction ?? "unknown",
  });
  const detail = value.detail;
  if (!detail) return;
  logEvent("info", "catalog", "browser_progress", "隐藏作品读取进度诊断", {
    attempt,
    documents: detail.documents,
    commits: detail.commits,
    pendingRequests: detail.pendingRequests,
    idleMs: detail.idleMs,
    omitted: detail.omitted,
    probeErrors: detail.probeErrors,
    contextResets: detail.contextResets,
  });
  logEvent("info", "catalog", "browser_runtime", "隐藏作品读取运行诊断", {
    attempt,
    engine: detail.engine,
    lastCdpCommand: detail.lastCdpCommand,
    lastCdpTarget: detail.lastCdpTarget,
    turnstileCode: detail.turnstileCode,
    ray: detail.ray,
  });
  for (const page of detail.pages) {
    logEvent("info", "catalog", "browser_page_state", "隐藏作品读取页面状态", {
      attempt,
      target: page.target,
      webdriver: page.webdriver,
      visibility: page.visibility,
      focused: page.focused,
      storage: page.storage,
      siteData: page.siteData,
      ready: page.ready,
    });
    logEvent("info", "catalog", "browser_interaction_state", "隐藏作品读取交互标志", {
      attempt,
      target: page.target,
      checkboxes: page.checkboxes,
      visibleCheckboxes: page.visibleCheckboxes,
      credentialForm: page.password,
      captcha: page.captcha,
      afterMs: page.afterMs,
    });
  }
  for (const request of detail.traces) {
    logEvent("info", "catalog", "browser_request_trace", "隐藏作品读取请求轨迹", {
      request: `${attempt}:${request.id}`,
      target: request.target,
      kind: request.kind,
      type: request.type,
      event: request.event,
      status: request.status,
      error: request.error,
      afterMs: request.afterMs,
    });
  }
}
