import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { Icon } from "./icons";

type MenuTrigger = "context" | "button";

const ObjectActions = createContext<{
  items: ReactNode;
  onOpen?: () => void;
  buttonOpened: boolean;
  onButtonChange: (opened: boolean) => void;
} | null>(null);

// 右键按下会被 Mantine 停止冒泡；捕获阶段关闭旧菜单，并覆盖键盘触发的 contextmenu。
const clickOutsideEvents = ["mousedown", "touchstart", "keydown", "contextmenu"];

export function ObjectMenu({
  children,
  items,
  onOpen,
}: {
  children: ReactElement;
  items: ReactNode;
  onOpen?: () => void;
}) {
  const [activeMenu, setActiveMenu] = useState<MenuTrigger | null>(null);
  const changeMenu = (trigger: MenuTrigger, opened: boolean) =>
    setActiveMenu((current) => (opened ? trigger : current === trigger ? null : current));

  return (
    <ObjectActions.Provider
      value={{
        items,
        onOpen,
        buttonOpened: activeMenu === "button",
        onButtonChange: (opened) => changeMenu("button", opened),
      }}
    >
      <Menu
        width={220}
        position="bottom-start"
        shadow="lg"
        loop
        returnFocus
        zIndex={350}
        opened={activeMenu === "context"}
        onChange={(opened) => changeMenu("context", opened)}
        clickOutsideCapture
        clickOutsideEvents={clickOutsideEvents}
        transitionProps={{ exitDuration: 0 }}
        onOpen={onOpen}
      >
        <Menu.ContextMenu>{children}</Menu.ContextMenu>
        <Menu.Dropdown>{items}</Menu.Dropdown>
      </Menu>
    </ObjectActions.Provider>
  );
}

export function ObjectMenuButton({ label }: { label: string }) {
  const actions = useContext(ObjectActions);
  return (
    <Menu
      width={220}
      position="bottom-end"
      shadow="lg"
      loop
      returnFocus
      zIndex={350}
      opened={actions?.buttonOpened}
      onChange={actions?.onButtonChange}
      clickOutsideCapture
      clickOutsideEvents={clickOutsideEvents}
      transitionProps={{ exitDuration: 0 }}
      onOpen={actions?.onOpen}
    >
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={label}
          title={label}
          data-menu-trigger
          onKeyDown={objectMenuKey}
        >
          <Icon name="more" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{actions?.items}</Menu.Dropdown>
    </Menu>
  );
}

// Mantine 的指针菜单与键盘菜单共用入口，保留方向键、Escape 和焦点返回行为。
export function objectMenuKey(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return false;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + Math.min(32, bounds.width / 2),
      clientY: Math.max(0, bounds.top) + Math.min(32, bounds.height / 2),
    }),
  );
  return true;
}
