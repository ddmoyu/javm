import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

// 宿主准备范围，不代表对应平台已能构建或发布完整 JAVM。
const hosts = new Map([
  ["win32-x64", "neutralino-win_x64.exe"],
  ["linux-x64", "neutralino-linux_x64"],
  ["darwin-x64", "neutralino-mac_x64"],
  ["darwin-arm64", "neutralino-mac_arm64"],
]);

export function desktopHostFile(platform = process.platform, arch = process.arch) {
  const filename = hosts.get(`${platform}-${arch}`);
  if (!filename) throw new Error(`尚未适配此桌面宿主：${platform}-${arch}`);
  return filename;
}

export async function installDesktopHost(
  source,
  destination,
  platform = process.platform,
  arch = process.arch,
) {
  const filename = desktopHostFile(platform, arch);
  await mkdir(destination, { recursive: true });
  const output = path.join(destination, filename);
  await copyFile(path.join(source, filename), output);
  if (platform !== "win32") await chmod(output, 0o755);
  return output;
}
