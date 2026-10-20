import config from "./supabase.json";
import type { AnalyticsPayload } from "./contract";
import type { HttpRequest } from "../network/HttpService";

/** 保留 0.5.3 的公开客户端配置、表名、冲突键和请求头，不需要 Supabase SDK。 */
export function analyticsRequest(payload: AnalyticsPayload, proxy: string): HttpRequest {
  return {
    purpose: "analytics",
    url: `${config.url}/rest/v1/${config.table}?on_conflict=user_id`,
    method: "POST",
    headers: {
      apikey: config.publishableKey,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([payload]),
    proxy,
    timeoutMs: 12_000,
    maxBytes: 16_384,
    maxRedirects: 0,
  };
}
