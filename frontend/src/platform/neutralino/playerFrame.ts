import { window as nativeWindow } from "@neutralinojs/lib";
import { refreshWindowState } from "./windowFrame";

/** 每次只保留一个待移动位置、一个原生请求，快速拖动不会积压 IPC。 */
export function startPlayerDrag(
  pointer: { screenX: number; screenY: number; clientX: number; clientY: number },
  maximized: boolean,
  report: (error: unknown) => void,
) {
  const scale = window.devicePixelRatio;
  const initial = { x: pointer.screenX, y: pointer.screenY };
  const anchor = { x: pointer.clientX / innerWidth, y: pointer.clientY * scale };
  let origin: { x: number; y: number } | undefined;
  let target: { x: number; y: number } | undefined;
  let moving = false;
  let ended = false;
  let moved = false;
  const flush = async () => {
    if (moving) return;
    moving = true;
    try {
      if (!origin) {
        if (maximized) {
          await nativeWindow.unmaximize();
          const size = await nativeWindow.getSize();
          origin = {
            x: initial.x * scale - (size.width ?? 960) * anchor.x,
            y: initial.y * scale - anchor.y,
          };
          await refreshWindowState();
        } else {
          const position = await nativeWindow.getPosition();
          origin = { x: position.x ?? 0, y: position.y ?? 0 };
        }
      }
      while (target) {
        const next = target;
        target = undefined;
        await nativeWindow.move(
          Math.round(origin.x + (next.x - initial.x) * scale),
          Math.round(origin.y + (next.y - initial.y) * scale),
        );
      }
    } catch (error) {
      target = undefined;
      ended = true;
      report(error);
    } finally {
      moving = false;
    }
  };
  return {
    move(screenX: number, screenY: number) {
      if (ended) return;
      if (!moved && Math.hypot(screenX - initial.x, screenY - initial.y) < 4) return;
      moved = true;
      target = { x: screenX, y: screenY };
      void flush();
    },
    finish() {
      ended = true;
    },
    cancel() {
      ended = true;
      target = undefined;
    },
  };
}
