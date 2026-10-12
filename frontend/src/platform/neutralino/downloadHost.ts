import { filesystem, os } from "@neutralinojs/lib";
import type { DownloadHost } from "../../services/downloads/ToolDownloadEngine";
import { joinPath } from "../../services/downloads/input";
import { findOnPath, runNativeProcess } from "./process";
import { NativeLibraryPort } from "./library";
import { createMediaProbe } from "../../services/downloads/probe";

const mediaPort = new NativeLibraryPort();

export function nativeRoot() {
  return (window as unknown as { NL_PATH: string }).NL_PATH;
}
async function stat(path: string) {
  try {
    return await filesystem.getStats(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "NE_FS_NOPATHE")
      return null;
    throw error;
  }
}

export const nativeDownloadHost: DownloadHost = {
  files: {
    stat,
    async mkdir(path) {
      const existing = await stat(path);
      if (existing) {
        if (!existing.isDirectory) throw new Error("保存路径被同名文件占用。");
        return;
      }
      await filesystem.createDirectory(path);
    },
    read: filesystem.readFile,
    write: filesystem.writeFile,
    async readBytes(path, length, position = 0) {
      return new Uint8Array(await filesystem.readBinaryFile(path, { pos: position, size: length }));
    },
    async writeBinary(path, value) {
      await filesystem.writeBinaryFile(path, value.slice().buffer);
    },
    async list(path) {
      return (await filesystem.readDirectory(path))
        .filter((entry) => entry.type === "FILE")
        .map((entry) => joinPath(path, entry.entry));
    },
    move: filesystem.move,
    async remove(path) {
      if (await stat(path)) await filesystem.remove(path);
    },
    async removeEmptyDirectory(path) {
      if (!(await stat(path))?.isDirectory) return;
      const entries = await filesystem.readDirectory(path);
      if (!entries.some((entry) => entry.entry !== "." && entry.entry !== ".."))
        await filesystem.remove(path);
    },
  },
  run: runNativeProcess,
  probe: createMediaProbe(mediaPort.request.bind(mediaPort)),
  async tool(name, configured) {
    const candidates = configured.trim()
      ? [configured.trim()]
      : [joinPath(nativeRoot(), "bin", "tools", `${name}.exe`)];
    for (const path of candidates) {
      if ((await stat(path))?.isFile) return path;
    }
    if (!configured.trim()) {
      const path = await findOnPath(`${name}.exe`);
      if (path) return path;
    }
    throw new Error(`下载组件 ${name} 缺失，请检查软件包是否完整。`);
  },
  defaultDirectory: () => os.getPath("downloads"),
  hlsWorker: () =>
    new Worker(new URL("../../services/downloads/hlsWorker.ts", import.meta.url), {
      type: "module",
    }),
  async open(path) {
    if (!(await stat(path))) throw new Error("文件或目录不存在。");
    await os.open(path);
  },
};
