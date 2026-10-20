import { os } from "@neutralinojs/lib";

async function applicationPath(kind: "data" | "cache", parts: string[]) {
  const platform = window.NL_OS;
  if (platform !== "Windows" && platform !== "Darwin" && platform !== "Linux")
    throw new Error("当前系统尚未适配应用数据目录。");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\0\r\n]/.test(part)))
    throw new Error("应用数据子目录无效。");

  // Windows 保留既有 LocalAppData 布局；getPath("data") 在该平台指向 Roaming。
  const value = platform === "Windows" ? await os.getEnv("LOCALAPPDATA") : await os.getPath(kind);
  const base = platform === "Windows" ? value.replaceAll("\\", "/") : value;
  const absolute =
    platform === "Windows"
      ? /^[a-z]:\//i.test(base) || /^\/\/[^/?.][^/]*\/[^/]+(?:\/|$)/.test(base)
      : base.startsWith("/");
  if (!absolute || /[\0\r\n]/.test(base)) throw new Error("无法定位应用数据目录。");
  const suffix = platform === "Windows" && kind === "cache" ? ["cache", ...parts] : parts;
  return [base.replace(/\/+$/, ""), "JAVM", ...suffix].join("/");
}

export const applicationDataPath = (...parts: string[]) => applicationPath("data", parts);
export const applicationCachePath = (...parts: string[]) => applicationPath("cache", parts);
