import { app, events, os, window as nativeWindow, MessageBoxChoice, Icon } from "@neutralinojs/lib";
import type { DownloadService } from "../../services/downloads/DownloadService";
import type { BackgroundSettingsService } from "../../services/settings/BackgroundSettingsService";
import { flushLogs, logEvent } from "../../services/logging/events";
import { stopApplicationLaunches } from "./applicationInstance";
import { prepareFeedbackExit, resumeFeedbackAfterFailedExit } from "./feedback";

let trayReady = false;
let traySetup: Promise<void> | undefined;
let service: DownloadService | undefined;
let exiting = false;
let stopLibrary: (() => Promise<void>) | undefined;
let backgroundSettings: BackgroundSettingsService | undefined;

function setTrayMenu() {
  return os.setTray({
    icon: "/resources/icon.png",
    menuItems: [
      { id: "show", text: "显示 JAVM", isDisabled: exiting },
      { text: "-" },
      { id: "exit", text: exiting ? "正在退出…" : "退出 JAVM", isDisabled: exiting },
    ],
  });
}

function setMacMenu() {
  if (window.NL_OS !== "Darwin") return;
  // Cocoa key equivalents use Command by default. Route Command-Q through the
  // same asynchronous task shutdown as the tray's explicit Quit action.
  void nativeWindow
    .setMainMenu([
      {
        text: "JAVM",
        menuItems: [
          { id: "javm-show", text: "显示 JAVM", isDisabled: exiting },
          { text: "-" },
          {
            id: "javm-quit",
            text: exiting ? "正在退出…" : "退出 JAVM",
            shortcut: "q",
            isDisabled: exiting,
          },
        ],
      },
    ])
    .catch(() => logEvent("warn", "app", "menu_update_failed", "应用菜单更新失败"));
}

function refreshTrayMenu() {
  setMacMenu();
  if (!trayReady) return;
  void setTrayMenu().catch(() => {
    logEvent("warn", "app", "tray_update_failed", "托盘状态更新失败");
  });
}

export async function exitApplication(beforeExit?: () => Promise<void>) {
  if (exiting) {
    if (beforeExit) throw new Error("应用已在退出，请等待退出后重试更新。");
    return;
  }
  exiting = true;
  refreshTrayMenu();
  stopApplicationLaunches();
  logEvent("info", "app", "exit_requested", "正在停止任务并退出应用");
  try {
    // 先暂停下载，再收尾依赖共享扩展的服务，最后才能关闭扩展进程。
    if (service) await service.shutdown(stopLibrary);
    else await stopLibrary?.();
    logEvent("info", "app", "stopped", "任务收尾完成，应用即将退出");
    await flushLogs();
    await beforeExit?.();
    await prepareFeedbackExit();
    await app.exit();
  } catch (error) {
    await resumeFeedbackAfterFailedExit();
    logEvent(
      "error",
      "app",
      "exit_failed",
      error instanceof Error ? error.message : "退出收尾失败",
    );
    exiting = false;
    refreshTrayMenu();
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
    if (exiting) return;
    void os
      .showNotification(
        "JAVM 仍在后台运行",
        "关闭窗口不会退出软件，后台任务将继续执行。如需彻底退出，请在托盘菜单中选择“退出 JAVM”。",
      )
      .catch(() => {
        logEvent("warn", "app", "background_notification_failed", "后台运行通知发送失败");
      });
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
    if (exiting) return;
    if (event.detail.id === "show") void nativeWindow.show().then(() => nativeWindow.focus());
    if (event.detail.id === "exit") void exitApplication().catch(report);
  });
  if (window.NL_OS === "Darwin") {
    void events.on("mainMenuItemClicked", (event: CustomEvent<{ id: string }>) => {
      if (exiting) return;
      if (event.detail.id === "javm-show")
        void nativeWindow.show().then(() => nativeWindow.focus());
      if (event.detail.id === "javm-quit") void exitApplication().catch(report);
    });
    setMacMenu();
  }
  traySetup = setTrayMenu()
    .then(() => {
      trayReady = true;
      if (exiting) refreshTrayMenu();
    })
    .catch(() => {
      trayReady = false;
    });
}
