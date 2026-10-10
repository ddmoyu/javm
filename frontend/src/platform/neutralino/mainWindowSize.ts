import { window as nativeWindow } from "@neutralinojs/lib";
import { nativeSettingsStorage } from "./settingsStorage";
import { logEvent } from "../../services/logging/events";

let initialized = false;
const migration = nativeSettingsStorage<boolean>("main-window-size-1440x900-v1");

async function adjustStartupSize() {
  const [migrated, size, maximized, fullScreen] = await Promise.all([
    migration.read(),
    nativeWindow.getSize(),
    nativeWindow.isMaximized(),
    nativeWindow.isFullScreen(),
  ]);
  if (maximized || fullScreen || !size.width || !size.height) return;

  // 宿主使用物理像素，screen 的可用区域使用 CSS 像素，需换算屏幕缩放。
  const scale = window.devicePixelRatio || 1;
  const availableWidth = Math.floor(window.screen.availWidth * scale);
  const availableHeight = Math.floor(window.screen.availHeight * scale);
  if (availableWidth <= 0 || availableHeight <= 0) return;
  const margin = Math.round(48 * scale);
  const maxWidth = Math.max(
    Math.min(size.minWidth ?? 760, availableWidth),
    availableWidth - margin,
  );
  const maxHeight = Math.max(
    Math.min(size.minHeight ?? 540, availableHeight),
    availableHeight - margin,
  );

  // 官方尺寸记忆会覆盖配置默认值；只迁移一次旧默认值，保留用户自定义尺寸。
  const oldDefault = migrated !== true && size.width === 1100 && size.height === 760;
  const width = Math.min(oldDefault ? 1440 : size.width, maxWidth);
  const height = Math.min(oldDefault ? 900 : size.height, maxHeight);
  if (width !== size.width || height !== size.height) {
    const constraints = {
      minWidth: Math.min(size.minWidth ?? 760, width),
      minHeight: Math.min(size.minHeight ?? 540, height),
      maxWidth: size.maxWidth,
      maxHeight: size.maxHeight,
    };
    // 与自绘边缘缩放一致：调整时关闭系统边框，恢复样式时不再次改写客户区尺寸。
    try {
      await nativeWindow.setSize({ ...constraints, width, height, resizable: false });
    } finally {
      try {
        await nativeWindow.setSize({
          ...constraints,
          width: -1,
          height: -1,
          resizable: size.resizable ?? true,
        });
      } finally {
        await nativeWindow.setBorderless(true);
      }
    }
    await nativeWindow.center();
  }
  if (migrated !== true) await migration.write(true);
}

/** 只由主窗口初始化，异步执行且不依赖 React 挂载次数。 */
export function initializeMainWindowSize() {
  if (initialized) return;
  initialized = true;
  void adjustStartupSize().catch(() => {
    logEvent("warn", "window", "startup_size_failed", "主窗口启动尺寸调整失败，保留当前窗口");
  });
}
