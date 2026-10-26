/** 更新检查、更新包和回退包统一使用官方优先的自动来源顺序。 */
export function updateSources(): string[] {
  return ["", "https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/"];
}
