import { MetadataConnectivity } from "../../services/metadata/MetadataConnectivity";
import type { MetadataConnectivityStatus } from "../../services/metadata/MetadataConnectivity";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { logEvent } from "../../services/logging/events";
import { requestHttp } from "./http";

const targets = ["https://www.gstatic.com/generate_204", "https://www.google.com/generate_204"];
const connectionFailures = new Set([5, 6, 7, 28, 35, 52, 55, 56, 60, 97]);

export function createMetadataConnectivity(proxy: string) {
  return new MetadataConnectivity(async (signal) => {
    const results = await Promise.allSettled(
      targets.map(async (url): Promise<MetadataConnectivityStatus> => {
        const result = await requestHttp(
          {
            url,
            proxy,
            purpose: "proxy",
            maxBytes: 1024,
            timeoutMs: 4000,
            connectTimeoutMs: 2500,
            maxRedirects: 0,
            cacheTtlMs: 0,
          },
          signal,
        );
        if (connectionFailures.has(result.exitCode)) return "unreachable";
        // 登录页、重定向、非预期响应不能证明检测站点正常，也不能证明网络不可达。
        return result.exitCode === 0 && result.status === 204 && result.bytes === 0
          ? "reachable"
          : "unknown";
      }),
    );
    const unsafeStop = results.find(
      (result) => result.status === "rejected" && result.reason instanceof StopUnconfirmedError,
    );
    if (unsafeStop?.status === "rejected") throw unsafeStop.reason;
    signal.throwIfAborted();
    const status = results.some(
      (result) => result.status === "fulfilled" && result.value === "reachable",
    )
      ? "reachable"
      : results.every((result) => result.status === "fulfilled" && result.value === "unreachable")
        ? "unreachable"
        : "unknown";
    logEvent("info", "metatube", "connectivity", "资料网络连通性检测已完成", {
      status,
      proxyEnabled: !!proxy,
    });
    return status;
  });
}
