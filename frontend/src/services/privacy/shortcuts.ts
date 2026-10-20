export interface PrivacyShortcut {
  key: string;
  modifier: "" | "Ctrl" | "Alt" | "Shift";
}

export const shortcutLabel = (shortcut: PrivacyShortcut) =>
  [shortcut.modifier, shortcut.key === "Escape" ? "Esc" : shortcut.key].filter(Boolean).join("+");

export function validateShortcut(value: unknown, global = false): PrivacyShortcut {
  if (!value || typeof value !== "object") throw new Error("快捷键格式无效。");
  const { key, modifier } = value as PrivacyShortcut;
  if (
    !["", "Ctrl", "Alt", "Shift"].includes(modifier) ||
    typeof key !== "string" ||
    !/^(Escape|[A-Z0-9]|F(?:[1-9]|1[01]))$/.test(key) ||
    (!modifier && /^[A-Z0-9]$/.test(key)) ||
    (global && key === "Escape")
  )
    throw new Error("请选择一个功能键，或一个修饰键加字母、数字或功能键；全局不能使用 Esc。");
  const label = shortcutLabel({ key, modifier });
  if (
    key === "Escape" ||
    (modifier === "Shift" && /^[A-Z0-9]$/.test(key)) ||
    [
      "Ctrl+B",
      "Ctrl+K",
      "Ctrl+A",
      "Ctrl+C",
      "Ctrl+V",
      "Ctrl+X",
      "Ctrl+Z",
      "Ctrl+Y",
      "Ctrl+F",
      "Ctrl+W",
      "Ctrl+R",
      "Ctrl+O",
      "Ctrl+P",
      "Ctrl+S",
      "Ctrl+N",
      "Ctrl+H",
      "Ctrl+L",
      "Ctrl+T",
      "Ctrl+F4",
      "Alt+F4",
      "Shift+F10",
      "F5",
      "F10",
      "F11",
    ].includes(label)
  )
    throw new Error("此快捷键与应用、文本编辑或系统操作冲突，请选择其他按键。");
  return { key, modifier };
}

export function matchesShortcut(event: KeyboardEvent, shortcut: PrivacyShortcut) {
  return (
    !event.metaKey &&
    event.ctrlKey === (shortcut.modifier === "Ctrl") &&
    event.altKey === (shortcut.modifier === "Alt") &&
    event.shiftKey === (shortcut.modifier === "Shift") &&
    event.key.toUpperCase() === shortcut.key.toUpperCase()
  );
}
