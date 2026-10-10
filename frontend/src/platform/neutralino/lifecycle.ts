import { app, events, os, window as nativeWindow, MessageBoxChoice, Icon } from "@neutralinojs/lib";
import type { DownloadService } from "../../services/downloads/DownloadService";
import type { BackgroundSettingsService } from "../../services/settings/BackgroundSettingsService";
import { flushLogs, logEvent } from "../../services/logging/events";

let trayReady = false;
let traySetup: Promise<void> | undefined;
let service: DownloadService | undefined;
let exiting = false;
let stopLibrary: (() => Promise<void>) | undefined;
let backgroundSettings: BackgroundSettingsService | undefined;

export async function exitApplication() {
  if (exiting) return;
  exiting = true;
  logEvent("info", "app", "exit_requested", "正在停止任务并退出应用");
  try {
    await stopLibrary?.();
    await service?.shutdown();
    logEvent("info", "app", "stopped", "任务收尾完成，应用即将退出");
    await flushLogs();
    await app.exit();
  } catch (error) {
    logEvent(
      "error",
      "app",
      "exit_failed",
      error instanceof Error ? error.message : "退出收尾失败",
    );
    exiting = false;
    throw error;
  }
}
export async function closeMainWindow() {
  if (exiting) return;
  const runInBackground = (await backgroundSettings?.shouldRunInBackground()) ?? true;
  if (exiting) return;
  if (runInBackground) await traySetup;
  if (exiting) return;
  if (runInBackground && trayReady) {
    await nativeWindow.hide();
    logEvent("info", "app", "hidden", "主窗口已隐藏，后台任务继续运行");
  } else await exitApplication();
}
export function initializeLifecycle(
  downloads: DownloadService,
  settings: BackgroundSettingsService,
  shutdownLibrary?: () => Promise<void>,
) {
  service = downloads;
  backgroundSettings = settings;
  stopLibrary = shutdownLibrary;
  const report = async () => {
    await nativeWindow.show();
    await os.showMessageBox(
      "退出失败",
      "尚未完成任务收尾，应用未退出。请检查任务状态后重试。",
      MessageBoxChoice.OK,
      Icon.ERROR,
    );
  };
  void events.on("windowClose", () => {
    void closeMainWindow().catch(report);
  });
  void events.on("trayMenuItemClicked", (event: CustomEvent<{ id: string }>) => {
    if (event.detail.id === "show") void nativeWindow.show().then(() => nativeWindow.focus());
    if (event.detail.id === "exit") void exitApplication().catch(report);
  });
  traySetup = os
    .setTray({
      icon: "/resources/icon.png",
      menuItems: [
        { id: "show", text: "显示 JAVM" },
        { text: "-" },
        { id: "exit", text: "退出 JAVM" },
      ],
    })
    .then(() => {
      trayReady = true;
    })
    .catch(() => {
      trayReady = false;
    });
}
