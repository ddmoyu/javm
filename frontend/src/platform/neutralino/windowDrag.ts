import { window as nativeWindow } from "@neutralinojs/lib";
import { toggleWindowMaximize } from "./windowFrame";

/** 点击留在 WebView，实际移动后才交给原生拖动，避免双击被原生移动循环吞掉。 */
export function bindWindowDragRegion(element: HTMLElement, notice: (message: string) => void) {
  let pointer: { id: number; x: number; y: number } | undefined;
  let dragging = false;
  const interactive = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest(
      "button, a, input, select, textarea, [role='button'], [contenteditable='true']",
    );
  const cancel = () => {
    const current = pointer;
    pointer = undefined;
    if (current && element.hasPointerCapture(current.id)) element.releasePointerCapture(current.id);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || dragging || interactive(event.target)) return;
    cancel();
    pointer = { id: event.pointerId, x: event.screenX, y: event.screenY };
    element.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      cancel();
      return;
    }
    if (Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) < 4) return;
    cancel();
    dragging = true;
    void nativeWindow
      .beginDrag(event.screenX, event.screenY)
      .catch(() => notice("窗口拖动失败，请重试"))
      .finally(() => {
        dragging = false;
      });
  };
  const release = (event: PointerEvent) => {
    if (pointer?.id === event.pointerId) cancel();
  };
  const doubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || dragging || interactive(event.target)) return;
    cancel();
    event.preventDefault();
    void toggleWindowMaximize().catch(() => notice("窗口操作失败，请重试"));
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
  element.addEventListener("lostpointercapture", release);
  element.addEventListener("dblclick", doubleClick);
  window.addEventListener("blur", cancel);
  return () => {
    cancel();
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", release);
    element.removeEventListener("pointercancel", release);
    element.removeEventListener("lostpointercapture", release);
    element.removeEventListener("dblclick", doubleClick);
    window.removeEventListener("blur", cancel);
  };
}
