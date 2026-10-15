import { window as nativeWindow } from "@neutralinojs/lib";
import { getWindowState } from "./windowFrame";

export type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

interface PointerPosition {
  screenX: number;
  screenY: number;
}

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 只保留最新指针位置，原生尺寸和位置更新串行执行，不积压拖动请求。 */
export function startWindowResize(edge: ResizeEdge, pointer: PointerPosition, report: () => void) {
  const initial = { x: pointer.screenX, y: pointer.screenY };
  // 主窗口未启用 useLogicalPixels，Neutralino 的尺寸和位置均使用物理像素。
  const scale = window.devicePixelRatio;
  const horizontal = edge.includes("w") ? -1 : edge.includes("e") ? 1 : 0;
  const vertical = edge.includes("n") ? -1 : edge.includes("s") ? 1 : 0;
  let target: PointerPosition | undefined;
  let origin: WindowRect | undefined;
  let sizeOptions: Awaited<ReturnType<typeof nativeWindow.getSize>> | undefined;
  let applied: WindowRect | undefined;
  let pending: Promise<void> | undefined;
  let frame: number | undefined;
  let ended = false;
  let cancelled = false;
  let frameChanged = false;
  let frameRestore: Promise<void> | undefined;
  let reported = false;

  const reportFailure = () => {
    if (reported) return;
    reported = true;
    report();
  };

  const restoreFrame = () => {
    if (frameRestore) return frameRestore;
    if (!frameChanged || !sizeOptions) return Promise.resolve();
    const { minWidth, minHeight, maxWidth, maxHeight } = sizeOptions;
    frameRestore = (async () => {
      try {
        // 客户端会自动补齐省略的宽高，必须显式传 -1，才能让 6.10
        // 宿主只恢复最大化样式而不按系统边框重新计算 WebView 客户区。
        await nativeWindow.setSize({
          width: -1,
          height: -1,
          minWidth,
          minHeight,
          maxWidth,
          maxHeight,
          resizable: true,
        });
      } finally {
        await nativeWindow.setBorderless(true);
      }
    })().catch(reportFailure);
    return frameRestore;
  };

  const clearFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const canResize = () => {
    const { maximized, fullScreen } = getWindowState();
    return !cancelled && !maximized && !fullScreen && !document.fullscreenElement;
  };
  const clamp = (value: number, min = 1, max = -1) =>
    Math.max(Math.max(1, min), Math.min(value, max > 0 ? max : Infinity));

  const applyLatest = async () => {
    if (!origin) {
      const [position, size, maximized, fullScreen] = await Promise.all([
        nativeWindow.getPosition(),
        nativeWindow.getSize(),
        nativeWindow.isMaximized(),
        nativeWindow.isFullScreen(),
      ]);
      // resizable 在自绘缩放期间会临时关闭。上次拖动被刷新/中断后，
      // 不能把残留的原生样式误当成禁止自绘缩放，否则窗口会一直锁住。
      if (maximized || fullScreen || !canResize()) {
        cancelled = true;
        target = undefined;
        return;
      }
      if (
        position.x === undefined ||
        position.y === undefined ||
        size.width === undefined ||
        size.height === undefined ||
        size.width <= 0 ||
        size.height <= 0
      )
        throw new Error("无法读取窗口尺寸");
      sizeOptions = size;
      origin = { x: position.x, y: position.y, width: size.width, height: size.height };
      applied = origin;
    }
    if (!canResize()) {
      target = undefined;
      return;
    }
    if (!target) return;
    const next = target;
    target = undefined;
    const width = horizontal
      ? clamp(
          origin.width + horizontal * Math.round((next.screenX - initial.x) * scale),
          sizeOptions?.minWidth,
          sizeOptions?.maxWidth,
        )
      : origin.width;
    const height = vertical
      ? clamp(
          origin.height + vertical * Math.round((next.screenY - initial.y) * scale),
          sizeOptions?.minHeight,
          sizeOptions?.maxHeight,
        )
      : origin.height;
    const x = horizontal < 0 ? origin.x + origin.width - width : origin.x;
    const y = vertical < 0 ? origin.y + origin.height - height : origin.y;
    if (width !== applied?.width || height !== applied?.height) {
      // 自绘边缘负责缩放；原生 resizable:true 会加回 WS_THICKFRAME，
      // 使 WebView 按带边框的客户区布局，随后再隐藏边框仍可能留下白边。
      // 在调整尺寸前保持系统边框关闭，让宿主直接按完整客户区布局。
      frameChanged = true;
      await nativeWindow.setSize({ ...sizeOptions, width, height, resizable: false });
    }
    if (!canResize()) return;
    if (x !== applied?.x || y !== applied?.y) await nativeWindow.move(x, y);
    applied = { x, y, width, height };
  };
  const schedule = () => {
    if (ended || pending || frame !== undefined || !target) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      void flush();
    });
  };
  const flush = (): Promise<void> => {
    if (pending) return pending;
    if (!target || cancelled) return Promise.resolve();
    pending = applyLatest()
      .catch(async () => {
        const shouldReport = !cancelled;
        cancelled = true;
        ended = true;
        target = undefined;
        if (shouldReport) reportFailure();
        await restoreFrame();
      })
      .finally(() => {
        pending = undefined;
        schedule();
      });
    return pending;
  };

  return {
    move(screenX: number, screenY: number) {
      if (ended) return;
      target = { screenX, screenY };
      schedule();
    },
    async finish() {
      ended = true;
      clearFrame();
      try {
        await pending;
        if (target && canResize()) await flush();
      } finally {
        await restoreFrame();
      }
    },
    async cancel() {
      ended = true;
      cancelled = true;
      target = undefined;
      clearFrame();
      await pending;
      await restoreFrame();
    },
  };
}
