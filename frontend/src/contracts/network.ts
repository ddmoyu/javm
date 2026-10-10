export interface NetworkSettings {
  proxyEnabled: boolean;
  proxy: string;
}

export const defaultNetworkSettings: NetworkSettings = { proxyEnabled: false, proxy: "" };

export function validateNetworkSettings(value: unknown): NetworkSettings {
  if (
    !value ||
    typeof value !== "object" ||
    !("proxyEnabled" in value) ||
    typeof value.proxyEnabled !== "boolean" ||
    !("proxy" in value) ||
    typeof value.proxy !== "string"
  )
    throw new Error("网络设置格式无效，请重新配置代理。");
  const proxy = value.proxy.trim();
  if (!proxy && !value.proxyEnabled) return { proxyEnabled: false, proxy: "" };
  const message = "请输入有效的 HTTP、HTTPS 或 SOCKS5 代理地址，例如 http://127.0.0.1:7890。";
  // Reject characters that could alter a downloader configuration file.
  // oxlint-disable-next-line no-control-regex
  if (/\s|[\u0000-\u001f\u007f]/.test(value.proxy) || proxy.length > 2048) throw new Error(message);
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error(message);
  }
  if (
    !/^(https?|socks5h?):$/.test(url.protocol) ||
    !url.hostname ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  )
    throw new Error(message);
  return { proxyEnabled: value.proxyEnabled, proxy };
}
