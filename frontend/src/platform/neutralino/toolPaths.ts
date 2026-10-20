import { filesystem, os } from "@neutralinojs/lib";

export type ToolPlatform = "Windows" | "Linux" | "Darwin";
export function toolPlatform(): ToolPlatform {
  const platform = window.NL_OS;
  if (platform !== "Windows" && platform !== "Linux" && platform !== "Darwin")
    throw new Error("当前系统尚未适配媒体工具。");
  return platform;
}
export function toolExecutableName(name: "ffmpeg" | "curl" | "metatube-server") {
  return toolPlatform() === "Windows" ? `${name}.exe` : name;
}
export function applicationToolPath(...parts: string[]) {
  const platform = toolPlatform();
  const value = (window as unknown as { NL_PATH: string }).NL_PATH;
  const root = platform === "Windows" ? value.replaceAll("\\", "/") : value;
  if (!root || /[\0\r\n]/.test(root) || (platform !== "Windows" && !root.startsWith("/")))
    throw new Error("无法定位应用工具目录。");
  return [root.replace(/\/+$/, ""), "bin", ...parts].join("/");
}
export function applicationResourcePath(...parts: string[]) {
  const toolPath = applicationToolPath(...parts);
  return toolPlatform() === "Darwin"
    ? toolPath.replace(/\/Contents\/MacOS\/bin\//, "/Contents/Resources/")
    : toolPath;
}
export async function executableExists(path: string, platform = toolPlatform()) {
  if (!path || path.includes("\0") || (platform !== "Windows" && !path.startsWith("/")))
    throw new Error("工具路径必须是有效的绝对路径。");
  try {
    if (!(await filesystem.getStats(path)).isFile) return false;
  } catch (error) {
    if ((error as { code?: string }).code === "NE_FS_NOPATHE") return false;
    throw error;
  }
  if (platform !== "Windows") {
    try {
      await filesystem.access(path, 1); // POSIX X_OK：包含当前用户、组及 ACL 的实际执行权限。
    } catch (error) {
      if ((error as { code?: string }).code !== "NE_FS_ACSFAIL") throw error;
      throw new Error("媒体工具没有执行权限，请检查安装包或所选程序。", { cause: error });
    }
  }
  return true;
}
export async function findPosixToolOnPath(name: string) {
  const path = await os.getEnv("PATH");
  if (path.length > 65536) throw new Error("系统 PATH 过长，无法查找媒体工具。");
  const directories = [...new Set(path.split(":"))];
  if (directories.length > 256) throw new Error("系统 PATH 目录过多，无法查找媒体工具。");
  for (const directory of directories) {
    // 空项和相对目录意味着当前工作目录，不能作为媒体工具的隐式来源。
    if (!directory.startsWith("/") || directory.includes("\0")) continue;
    const candidate = `${directory.replace(/\/+$/, "")}/${name}`;
    try {
      if (await executableExists(candidate)) return candidate;
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code !== "NE_FS_ACSFAIL") throw error;
    }
  }
  return "";
}
