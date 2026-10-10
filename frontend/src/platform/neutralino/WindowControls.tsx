import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Group, UnstyledButton } from "@mantine/core";
import { window as nativeWindow } from "@neutralinojs/lib";
import { closeMainWindow } from "./lifecycle";
import { Icon } from "../../components/icons";
import type { Runtime } from "./bootstrap";
import { getWindowState, refreshWindowState, subscribeWindowState } from "./windowFrame";

export function WindowDragRegion({
  runtime,
  notice,
  children,
}: {
  runtime: Runtime;
  notice: (message: string) => void;
  children: ReactNode;
}) {
  return (
    <div
      className="titlebar-drag"
      id="window-drag-region"
      onPointerDown={(event) => {
        if (runtime === "desktop" && event.button === 0) {
          void nativeWindow.beginDrag().catch(() => notice("窗口拖动失败，请重试"));
        }
      }}
    >
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
      else {
        const current = await nativeWindow.isMaximized();
        await (current ? nativeWindow.unmaximize() : nativeWindow.maximize());
        await refreshWindowState();
      }
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
