import packageInfo from "../../../../package.json";
import { AnalyticsService, AnalyticsUploadError } from "../../services/analytics/AnalyticsService";
import type { AnalyticsLoad } from "../../services/analytics/contract";
import { analyticsRequest } from "../../services/analytics/supabase";
import { setUsageRecorder } from "../../services/analytics/events";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import type { Runtime } from "./bootstrap";
import { NativeLibraryPort } from "./library";
import { requestHttp } from "./http";

let service: AnalyticsService | undefined;
export function createApplicationAnalytics(runtime: Runtime, network: NetworkSettingsService) {
  // 浏览器预览、播放器子窗口和非主实例均不创建统计服务。
  if (runtime !== "desktop") return undefined;
  if (service) return service;
  const port = new NativeLibraryPort(false, true);
  service = new AnalyticsService(
    {
      load: () => port.request<AnalyticsLoad>("library.analytics.load"),
      save: (state, expectedRevision) =>
        port.request("library.analytics.save", { state, expectedRevision }),
      videoCount: async () =>
        (await port.request<{ videoCount: number }>("library.analytics.context")).videoCount,
      async upload(payload, signal) {
        const proxy = await network.getProxy();
        signal.throwIfAborted();
        const result = await requestHttp(analyticsRequest(payload, proxy), signal);
        if (result.exitCode || result.status < 200 || result.status >= 300)
          throw new AnalyticsUploadError(result.status, result.exitCode);
      },
    },
    {
      os: window.NL_OS === "Windows" ? "windows" : window.NL_OS === "Darwin" ? "macos" : "linux",
      cpu_arch:
        window.NL_ARCH === "x64"
          ? "x86_64"
          : ["arm", "arm64"].includes(window.NL_ARCH)
            ? "aarch64"
            : window.NL_ARCH === "ia32"
              ? "x86"
              : window.NL_ARCH,
      system_language: navigator.language.trim(),
      app_version: packageInfo.version,
    },
    () => !document.hidden,
  );
  setUsageRecorder(service.record);
  document.addEventListener("visibilitychange", service.visibilityChanged);
  service.start();
  return service;
}
export async function shutdownAnalytics() {
  setUsageRecorder();
  if (service) document.removeEventListener("visibilitychange", service.visibilityChanged);
  await service?.shutdown();
}
