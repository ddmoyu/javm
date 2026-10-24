export type UpdateMirror = "auto" | "official" | "gh-proxy" | "ghfast" | "ghproxy-net" | "custom";
export const updateMirrorOptions = [
  { value: "auto", label: "自动（官方优先）" },
  { value: "official", label: "仅 GitHub 官方源" },
  { value: "gh-proxy", label: "GH-Proxy（社区镜像）" },
  { value: "ghfast", label: "GHFast（社区镜像）" },
  { value: "ghproxy-net", label: "GHProxy.net（社区镜像）" },
  { value: "custom", label: "自定义镜像" },
] as const;
export function isUpdateMirror(value: unknown): value is UpdateMirror {
  return updateMirrorOptions.some((option) => option.value === value);
}
export function normalizeUpdateMirror(value: string) {
  const prefix = value.trim();
  // 与原生下载端使用相同约束：公开 HTTPS 前缀，不接受凭据、查询或任意模板。
  if (
    prefix.length > 512 ||
    !/^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_-]+)*\/?$/.test(prefix)
  )
    throw new Error("镜像地址须为 HTTPS 域名或路径前缀，不能包含账号、端口、查询参数或文件链接。");
  return prefix.endsWith("/") ? prefix : prefix + "/";
}
export function updateSources(mirror: UpdateMirror, custom = ""): string[] {
  switch (mirror) {
    case "official":
      return [""];
    case "gh-proxy":
      return ["https://gh-proxy.com/", ""];
    case "ghfast":
      return ["https://ghfast.top/", ""];
    case "ghproxy-net":
      return ["https://ghproxy.net/", ""];
    case "custom":
      return [normalizeUpdateMirror(custom), ""];
    default:
      return ["", "https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/"];
  }
}
