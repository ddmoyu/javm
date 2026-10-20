import type { ProcessResult } from "../../platform/neutralino/process";

// curl distinguishes network errors from local I/O, invocation and resume errors.
// 22 also covers HTTP 403, which region-restricted CDNs answer before a proxy helps.
const curlNetworkErrors = new Set([5, 6, 7, 16, 18, 22, 28, 35, 52, 55, 56, 60, 92, 95, 96, 97]);

/** curl 退出码是否属于网络类错误（不含 HTTP 状态判断）。 */
export function isNetworkFailure(code: number) {
  return code !== 22 && curlNetworkErrors.has(code);
}

export function canRetryWithProxy(result: ProcessResult) {
  return result.exitCode !== 0 && curlNetworkErrors.has(result.exitCode);
}

const curlHints: Record<number, string> = {
  5: "无法解析代理地址，请检查网络与代理设置。",
  6: "无法解析域名，请检查网络或链接。",
  7: "无法连接服务器，请检查网络或代理。",
  18: "传输中途断开，可继续下载。",
  22: "服务器拒绝了请求，链接可能已过期或需要重新查找。",
  23: "写入本地文件失败，请检查磁盘空间和保存目录权限。",
  26: "读取本地文件失败，请检查保存目录。",
  28: "连接或传输超时，可稍后继续下载。",
  35: "TLS 握手失败，可尝试启用代理。",
  52: "服务器没有返回任何数据。",
  55: "发送数据失败，网络连接可能已断开。",
  56: "接收数据失败，网络连接可能已断开。",
  60: "服务器证书校验失败。",
  63: "文件超过允许的大小上限。",
};
/** curl 退出码对应的中文说明，便于用户判断是网络、链接还是磁盘问题。 */
export function curlExitHint(code: number) {
  return curlHints[code] ?? "";
}
