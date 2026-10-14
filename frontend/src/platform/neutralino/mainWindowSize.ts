import { filesystem, window as nativeWindow } from "@neutralinojs/lib";
import { nativeSettingsStorage } from "./settingsStorage";
import { logEvent } from "../../services/logging/events";
import { NativeLibraryPort } from "./library";
import type { DesktopRect, WindowDisplay } from "../../contracts/window";

let initialization: Promise<void> | undefined;
const migration = nativeSettingsStorage<boolean>("main-window-size-1440x900-v1");
const displaysPort = new NativeLibraryPort();
const defaultSize = { width: 1440, height: 900 };

async function readSavedSize() {
  try {
    // 只读官方宿主保存的尺寸，不另建一份状态，也不改写宿主文件。
    const saved: unknown = JSON.parse(
      await filesystem.readFile(`${window.NL_DATAPATH}/.tmp/window_state.config.json`),
    );
    if (!saved || typeof saved !== "object" || !("width" in saved) || !("height" in saved))
      return undefined;
    const { width, height } = saved;
    if (
      typeof width === "number" &&
      typeof height === "number" &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    )
      return { width, height };
  } catch {
    // 宿主尚未保存、记录损坏或不可读时只恢复运行尺寸，保留原文件。
  }
  return undefined;
}

function validRect(rect: DesktopRect) {
  return Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

function intersectionArea(a: DesktopRect, b: DesktopRect) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}

function containingDisplay(rect: DesktopRect, displays: WindowDisplay[]) {
  if (!validRect(rect)) return undefined;
  let selected: WindowDisplay | undefined;
  let area = 0;
  for (const display of displays) {
    const next = intersectionArea(rect, display.bounds);
    if (next > area) {
      selected = display;
      area = next;
    }
  }
  return selected;
}

async function adjustStartupSize() {
  const [migrated, size, position, maximized, fullScreen, minimized, displays] = await Promise.all([
    // 设置读取失败时保留用户尺寸，不能阻止窗口位置恢复。
    migration.read().catch(() => true),
    nativeWindow.getSize(),
    nativeWindow.getPosition(),
    nativeWindow.isMaximized(),
    nativeWindow.isFullScreen(),
    nativeWindow.isMinimized(),
    displaysPort.request<WindowDisplay[]>("window.displays"),
  ]);
  if (maximized || fullScreen || minimized) return;
  const screens = displays.filter(
    (display) => validRect(display.bounds) && validRect(display.workArea),
  );
  const primary = screens.find((display) => display.primary);
  if (!primary) throw new Error("没有可用的主显示器");
  const rect = {
    x: position.x ?? NaN,
    y: position.y ?? NaN,
    width: size.width ?? NaN,
    height: size.height ?? NaN,
  };
  const current = containingDisplay(rect, screens);
  let recover = !current;
  let restoredSize: typeof defaultSize | undefined;
  if (rect.width <= (size.minWidth ?? 760) && rect.height <= (size.minHeight ?? 540)) {
    const saved = await readSavedSize();
    if (saved && (saved.width > rect.width || saved.height > rect.height)) restoredSize = saved;
    else if (recover || !saved) restoredSize = defaultSize;
    // 位置正常且保存的也是最小尺寸，视为用户主动选择，继续保留。
  }

  // 原生显示区域与窗口位置均为物理像素，不能按当前屏幕 DPI 再缩放副屏坐标。
  const fit = (value: number, minimum: number, available: number) =>
    Math.min(value, Math.max(Math.min(minimum, available), available - 48));
  // 官方尺寸记忆会覆盖配置默认值；只迁移一次旧默认值，保留用户自定义尺寸。
  const oldDefault = migrated !== true && size.width === 1100 && size.height === 760;
  const desiredWidth =
    restoredSize?.width ??
    (oldDefault || !Number.isFinite(rect.width) || rect.width <= 0
      ? defaultSize.width
      : rect.width);
  const desiredHeight =
    restoredSize?.height ??
    (oldDefault || !Number.isFinite(rect.height) || rect.height <= 0
      ? defaultSize.height
      : rect.height);
  const fitSize = (display: WindowDisplay) => ({
    width: fit(desiredWidth, size.minWidth ?? 760, display.workArea.width),
    height: fit(desiredHeight, size.minHeight ?? 540, display.workArea.height),
  });
  let { width, height } = fitSize(current ?? primary);
  // 缩小跨屏大窗口后若已完全离屏，同样恢复到主屏。
  if (!recover && !containingDisplay({ ...rect, width, height }, screens)) {
    recover = true;
    ({ width, height } = fitSize(primary));
  }
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
  }
  if (recover) {
    const { workArea } = primary;
    let movedTo: { x: number; y: number } | undefined;
    // 以实际尺寸居中；跨 DPI 显示器移动后再核对一次，避免系统调整尺寸造成偏移。
    for (let attempt = 0; attempt < 2; attempt++) {
      const actual = await nativeWindow.getSize();
      if (
        !actual.width ||
        !actual.height ||
        !Number.isFinite(actual.width) ||
        !Number.isFinite(actual.height)
      )
        throw new Error("无法读取恢复后的窗口尺寸");
      const x = Math.round(workArea.x + (workArea.width - actual.width) / 2);
      const y = Math.round(workArea.y + (workArea.height - actual.height) / 2);
      if (x === movedTo?.x && y === movedTo?.y) break;
      await nativeWindow.move(x, y);
      movedTo = { x, y };
    }
    logEvent("info", "window", "startup_position_recovered", "主窗口已从屏幕外恢复到主屏幕中央");
  }
  if (restoredSize)
    logEvent("info", "window", "startup_size_recovered", "主窗口已从异常最小尺寸恢复", {
      width,
      height,
    });
  if (migrated !== true) await migration.write(true);
}

/** 只由主窗口初始化，异步执行且不依赖 React 挂载次数。 */
export function initializeMainWindowSize() {
  return (initialization ??= adjustStartupSize().catch(() => {
    logEvent("warn", "window", "startup_size_failed", "主窗口启动位置或尺寸调整失败，保留当前窗口");
  }));
}
