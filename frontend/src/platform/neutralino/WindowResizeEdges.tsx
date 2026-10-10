import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { getWindowState, subscribeWindowState } from "./windowFrame";
import { startWindowResize } from "./windowResize";
import type { ResizeEdge } from "./windowResize";

const edges: ResizeEdge[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

interface ResizeSession {
  pointerId: number;
  element: HTMLDivElement;
  controller: ReturnType<typeof startWindowResize>;
  released: boolean;
}

export function WindowResizeEdges({ notice }: { notice: (message: string) => void }) {
  const session = useRef<ResizeSession | null>(null);
  const stop = useCallback((cancel: boolean) => {
    const current = session.current;
    if (!current || (current.released && !cancel)) return;
    current.released = true;
    const completion = cancel ? current.controller.cancel() : current.controller.finish();
    if (current.element.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
    // 上一轮原生调用结束前不开始新一轮，防止旧尺寸覆盖新的拖动。
    void completion.finally(() => {
      if (session.current === current) session.current = null;
    });
  }, []);

  useEffect(() => {
    const cancel = () => stop(true);
    const onStateChange = () => {
      const { maximized, fullScreen } = getWindowState();
      if (maximized || fullScreen) cancel();
    };
    const onVisibilityChange = () => {
      if (document.hidden) cancel();
    };
    const unsubscribe = subscribeWindowState(onStateChange);
    window.addEventListener("blur", cancel);
    document.addEventListener("fullscreenchange", cancel);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancel();
      unsubscribe();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("fullscreenchange", cancel);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [stop]);

  const begin = (event: PointerEvent<HTMLDivElement>, edge: ResizeEdge) => {
    const { maximized, fullScreen } = getWindowState();
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      session.current ||
      maximized ||
      fullScreen ||
      document.fullscreenElement
    )
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      controller: startWindowResize(edge, event, () => notice("调整窗口大小失败，请重试")),
      released: false,
    };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (session.current?.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) stop(false);
    else session.current.controller.move(event.screenX, event.screenY);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    if (session.current?.pointerId !== event.pointerId) return;
    if (!cancel) session.current.controller.move(event.screenX, event.screenY);
    stop(cancel);
  };

  return (
    <div className="window-resize-edges" aria-hidden="true">
      {edges.map((edge) => (
        <div
          key={edge}
          className="window-resize-edge"
          data-edge={edge}
          onPointerDown={(event) => begin(event, edge)}
          onPointerMove={move}
          onPointerUp={(event) => finish(event, false)}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => {
            if (!session.current?.released) finish(event, true);
          }}
        />
      ))}
    </div>
  );
}
