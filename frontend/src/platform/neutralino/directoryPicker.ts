import { filesystem, os } from "@neutralinojs/lib";

export function selectMediaDirectory(currentPath = "") {
  return os.showFolderDialog("选择媒体目录", currentPath ? { defaultPath: currentPath } : {});
}

export async function openMediaDirectory(path: string) {
  try {
    if (!(await filesystem.getStats(path)).isDirectory) throw new Error("目录不存在");
    await os.open(path);
  } catch {
    throw new Error("无法打开目录，请检查磁盘连接和访问权限。");
  }
}
