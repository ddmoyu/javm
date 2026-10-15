export function suppressNativeContextMenu(event: Event) {
  // 在冒泡阶段取消默认菜单，让 React / Mantine 先处理明确提供的业务菜单。
  // 不停止传播，也不在捕获阶段设置 defaultPrevented，否则 Mantine 会跳过菜单。
  event.preventDefault();
}

export function initializeContextMenu() {
  document.addEventListener("contextmenu", suppressNativeContextMenu);
}
