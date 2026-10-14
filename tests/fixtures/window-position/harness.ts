import { app, filesystem, init, window as nativeWindow } from "@neutralinojs/lib";
import { initializeMainWindowSize } from "../../../frontend/src/platform/neutralino/mainWindowSize";
import { NativeLibraryPort } from "../../../frontend/src/platform/neutralino/library";
import type { WindowDisplay } from "../../../frontend/src/contracts/window";

init();
const snapshot = async () => ({
  position: await nativeWindow.getPosition(),
  size: await nativeWindow.getSize(),
});
async function run() {
  await nativeWindow.hide();
  if (new URL(location.href).searchParams.get("simulateMinimum") === "true") {
    // 复现启动后缩至最小尺寸，但磁盘上仍保存着正常尺寸的故障。
    // 只操作隔离安全宿主，不改写保存记录。
    await nativeWindow.setSize({ width: 760, height: 540, resizable: false });
    await nativeWindow.setSize({ width: -1, height: -1, resizable: true });
    await nativeWindow.setBorderless(true);
  }
  const before = await snapshot();
  const displays = await new NativeLibraryPort().request<WindowDisplay[]>("window.displays");
  await initializeMainWindowSize();
  const after = await snapshot();
  await filesystem.writeFile(
    `${window.NL_DATAPATH}/result.json`,
    JSON.stringify({ before, after, displays }),
  );
  await app.exit();
}
void run().catch(async (error: unknown) => {
  await filesystem.writeFile(
    `${window.NL_DATAPATH}/result.json`,
    JSON.stringify({ error: String(error) }),
  );
  await app.exit(1);
});
