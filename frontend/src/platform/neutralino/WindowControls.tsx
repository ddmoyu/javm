import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Group, UnstyledButton } from "@mantine/core";
import { window as nativeWindow } from "@neutralinojs/lib";
import { closeMainWindow } from "./lifecycle";
import { Icon } from "../../components/icons";
import type { Runtime } from "./bootstrap";
import { getWindowState, subscribeWindowState, toggleWindowMaximize } from "./windowFrame";
import { bindWindowDragRegion } from "./windowDrag";

export function WindowDragRegion({
  runtime,
  notice,
  children,
}: {
  runtime: Runtime;
  notice: (message: string) => void;
  children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  const report = useEffectEvent(notice);
  useEffect(() => {
    if (runtime === "desktop" && region.current)
      return bindWindowDragRegion(region.current, (message) => report(message));
  }, [runtime]);
  return (
    <div className="titlebar-drag" id="window-drag-region" ref={region}>
      {children}
    </div>
  );
}

export function WindowControls({
  runtime,
  notice,
}: {
  runtime: Runtime;
  notice: (message: string) => void;
}) {
  const { maximized } = useSyncExternalStore(subscribeWindowState, getWindowState);
  const perform = async (action: "minimize" | "maximize" | "close") => {
    if (runtime !== "desktop") return;
    try {
      if (action === "close") await closeMainWindow();
      else if (action === "minimize") await nativeWindow.minimize();
      else await toggleWindowMaximize();
    } catch {
      notice(
        action === "close"
          ? "关闭失败，应用未退出，请检查设置和任务状态后重试"
          : "窗口操作失败，请重试",
      );
    }
  };
  return (
    <Group gap={0} wrap="nowrap">
      <UnstyledButton
        className="window-button"
        aria-label="最小化窗口"
        disabled={runtime !== "desktop"}
        onClick={() => void perform("minimize")}
      >
        <Icon name="minimize" size={14} />
      </UnstyledButton>
      <UnstyledButton
        className="window-button"
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
        disabled={runtime !== "desktop"}
        onClick={() => void perform("maximize")}
      >
        <Icon name={maximized ? "restore" : "maximize"} size={12} />
      </UnstyledButton>
      <UnstyledButton
        className="window-button close"
        aria-label="关闭窗口"
        disabled={runtime !== "desktop"}
        onClick={() => void perform("close")}
      >
        <Icon name="close" size={15} />
      </UnstyledButton>
    </Group>
  );
}
