import type { ProxyProbe } from "../../services/network/NetworkSettingsService";
import { findOnPath, runNativeProcess } from "./process";

export const testProxyConnection: ProxyProbe = async (proxy, signal) => {
  signal.throwIfAborted();
  const curl = await findOnPath("curl.exe");
  signal.throwIfAborted();
  if (!curl) throw new Error("找不到 curl，无法测试代理，请检查软件包是否完整。");
  const result = await runNativeProcess(
    curl,
    [
      "--disable",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      "--max-filesize",
      "1024",
      "--proto",
      "=https",
      "--proxy",
      proxy,
      "--noproxy",
      "",
      "--output",
      "NUL",
      "--write-out",
      "%{http_code}\n%{http_connect}\n%{time_total}",
      "--url",
      "https://www.gstatic.com/generate_204",
    ],
    signal,
    undefined,
    true,
  );
  signal.throwIfAborted();
  const [status, tunnelStatus, seconds] = result.stdOut.trim().split(/\r?\n/).map(Number);
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
  if (status !== 204 || !Number.isFinite(seconds) || seconds! < 0)
    throw new Error(
      status && status >= 100 && status <= 599
        ? `测试站点返回 HTTP ${status}，代理连通性测试未通过。`
        : "未收到测试站点的有效响应，代理连通性测试未通过。",
    );
  return { elapsedMs: Math.round(seconds! * 1000) };
};
