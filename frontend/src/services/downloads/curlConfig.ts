import type { DownloadTask } from "../../contracts/downloads";

export const configValue = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;

/**
 * 资源解析阶段把请求头名统一为小写；HTTP/1.1 下浏览器发送 User-Agent 这类标准写法，
 * 部分 CDN 防护会把小写 user-agent 当作机器人特征而返回 403。
 */
export const headerName = (name: string) =>
  name.replace(
    /(^|-)([a-z])/g,
    (_, separator: string, letter: string) => separator + letter.toUpperCase(),
  );

/** 所有 curl 调用共用的代理与请求头配置。 */
export function curlContext(task: Pick<DownloadTask, "headers">, proxy: string) {
  const lines = [
    `proxy = ${configValue(proxy)}`,
    // Override inherited HTTP(S)_PROXY and NO_PROXY in both phases.
    `noproxy = ${configValue(proxy ? "" : "*")}`,
  ];
  for (const [key, value] of Object.entries(task.headers))
    lines.push(`header = ${configValue(`${headerName(key)}: ${value}`)}`);
  return lines;
}
/**
 * 所有 curl 调用的公共安全参数。--globoff 关闭 URL 通配展开：
 * 分片地址里的 [ ] { } 是普通字符，展开后会变成多个请求或直接报错（退出码 3）。
 */
export const curlSafety = [
  "--globoff",
  "--location",
  "--proto",
  "=http,https",
  "--proto-redir",
  "=http,https",
  "--fail",
  "--connect-timeout",
  "20",
  "--speed-time",
  "60",
  "--speed-limit",
  "1",
];
