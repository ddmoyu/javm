import { app, filesystem, storage } from "@neutralinojs/lib";
import { NativeLibraryPort } from "./library";
import { commitUpdateStartup, holdUpdateStartup } from "./updateGate";
import type { NativeUpdateStatus, UpdateInstallation } from "../../contracts/updates";

export const updateRpc = new NativeLibraryPort(true);
let configured: Promise<UpdateInstallation> | undefined;
let trial = false;
let confirming: Promise<void> | undefined;
export function configureUpdater() {
  return (configured ??= updateRpc.request<UpdateInstallation>("update.configure", {
    appPath: window.NL_PATH,
    settings: `${window.NL_DATAPATH}/.storage`,
    ownerPid: Number((window as unknown as { NL_PID: number }).NL_PID),
  }));
}
export async function prepareUpdateStartup() {
  const installation = await configureUpdater();
  if (!installation.kind) return;
  const state = await updateRpc.request<{ trial: boolean; recovering?: boolean }>("update.trial");
  if (state.recovering) {
    await app.exit();
    return false;
  }
  trial = state.trial;
  if (trial) holdUpdateStartup();
  return true;
}
export function confirmUpdateStartup() {
  if (!trial) return Promise.resolve();
  return (confirming ??= (async () => {
    // 仅这两个健康探测可在业务门闩之前触发迁移；安装助手已持有旧快照。
    await updateRpc.request("hello");
    await updateRpc.request("library.status");
    let keys: string[];
    try {
      keys = await storage.getKeys();
    } catch (error) {
      if ((error as { code?: string }).code !== "NE_ST_NOSTDIR") throw error;
      keys = [];
    }
    for (const key of keys) {
      const value = await storage.getData(key);
      if (value.length > 4 * 1024 * 1024) throw new Error("设置文件过大，更新验证失败。");
      JSON.parse(value);
    }
    await updateRpc.request("update.healthy");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await updateRpc.request<NativeUpdateStatus>("update.status");
      if (state.phase === "committed") {
        commitUpdateStartup();
        return;
      }
      if (["failed", "rolling-back", "rolled-back"].includes(state.phase))
        throw new Error("新版启动验证未通过，正在恢复旧版。");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("更新提交超时，安装助手将恢复旧版。");
  })());
}
export async function markUpdateExitReady(file: string) {
  // 扩展将在下载仓库 close 时结束；最后标记使用官方文件 API。
  await filesystem.writeFile(file, JSON.stringify({ ready: true }));
}
export async function cancelUpdateHandoff(readyFile: string) {
  if (!readyFile.endsWith("exit-ready.json")) throw new Error("更新退出标记路径无效。");
  await filesystem.writeFile(
    readyFile.slice(0, -"exit-ready.json".length) + "exit-cancelled.json",
    JSON.stringify({ cancelled: true }),
  );
}
