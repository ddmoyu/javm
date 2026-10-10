import { Icon, MessageBoxChoice, os, window as nativeWindow } from "@neutralinojs/lib";
import { logEvent } from "../../services/logging/events";

const previews = new Set<HTMLElement>();
let enteredByPreview = false;
let syncing = false;
let pending = false;

function fullscreenPreview() {
  const element = document.fullscreenElement;
  return element && [...previews].some((preview) => preview.contains(element)) ? element : null;
}

function syncWindowFullscreen() {
  pending = true;
  if (syncing) return;
  syncing = true;
  void (async () => {
    try {
      // 合并连续切换；关闭旧图箱、打开新图箱也共用一条原生操作链。
      while (pending) {
        pending = false;
        if (fullscreenPreview()) {
          if (!enteredByPreview && !(await nativeWindow.isFullScreen()) && fullscreenPreview()) {
            await nativeWindow.setFullScreen();
            enteredByPreview = true;
          }
        } else if (enteredByPreview) {
          await nativeWindow.exitFullScreen();
          enteredByPreview = false;
        }
      }
    } catch {
      logEvent("error", "window", "image_fullscreen_failed", "图片预览全屏切换失败");
      // 原生进入失败时撤回网页全屏，避免按钮仍显示已全屏。
      if (!enteredByPreview && fullscreenPreview()) {
        await document.exitFullscreen().catch(() => {});
      }
      void os
        .showMessageBox("JAVM", "图片预览全屏切换失败，请重试。", MessageBoxChoice.OK, Icon.ERROR)
        .catch(() => {});
    } finally {
      syncing = false;
      if (pending) syncWindowFullscreen();
    }
  })();
}

/** WebView 的网页全屏不会自动改变宿主窗口，图箱需要同步原生全屏。 */
export function bindImagePreviewFullscreen(element: HTMLElement | undefined) {
  if (!element || !("NL_PORT" in window)) return () => {};
  if (!previews.size) document.addEventListener("fullscreenchange", syncWindowFullscreen);
  previews.add(element);
  syncWindowFullscreen();
  return () => {
    if (!previews.delete(element)) return;
    if (!previews.size) document.removeEventListener("fullscreenchange", syncWindowFullscreen);
    // 即使进入全屏的调用仍在等待，也会在完成后恢复；不退出原本就有的全屏。
    syncWindowFullscreen();
  };
}
