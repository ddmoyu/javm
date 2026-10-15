import type { ProxyProbe } from "../../services/network/NetworkSettingsService";
import { requestHttp } from "./http";

export const testProxyConnection: ProxyProbe = async (proxy, signal) => {
  signal.throwIfAborted();
  const result = await requestHttp(
    {
      purpose: "proxy",
      url: "https://www.gstatic.com/generate_204",
      proxy,
      maxBytes: 1024,
      timeoutMs: 15_000,
    },
    signal,
  );
  signal.throwIfAborted();
  const { status, tunnelStatus, elapsedMs } = result;
  if (status === 407 || tunnelStatus === 407 || result.exitCode === 67)
    throw new Error("代理认证失败，请检查代理用户名和密码。");
  if (result.exitCode !== 0) {
    const reasons: Record<number, string> = {
      5: "无法解析代理地址，请检查主机名。",
      6: "无法解析测试站点，请检查代理的 DNS 设置。",
      7: "无法连接代理，请检查地址、端口和代理服务是否已启动。",
      28: "代理测试超时，请检查代理服务和网络后重试。",
      35: "HTTPS 握手失败，请检查代理是否支持 HTTPS 连接。",
      60: "HTTPS 证书验证失败，请检查代理证书和系统时间。",
      97: "SOCKS5 代理连接失败，请检查地址、认证和代理服务状态。",
    };
    // 原始 curl 错误可能包含带凭据的代理地址，不进入界面或日志。
    throw new Error(reasons[result.exitCode] ?? "代理未能连接测试站点，请检查代理服务后重试。");
  }
  if (status !== 204 || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new Error(
      status && status >= 100 && status <= 599
        ? `测试站点返回 HTTP ${status}，代理连通性测试未通过。`
        : "未收到测试站点的有效响应，代理连通性测试未通过。",
    );
  return { elapsedMs: Math.round(elapsedMs) };
};
