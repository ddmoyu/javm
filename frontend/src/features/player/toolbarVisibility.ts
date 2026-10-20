const idleDelay = 3000;

/** 只更新悬浮层属性，不让鼠标移动触发 React 或媒体引擎重新渲染。 */
export function bindToolbarVisibility(player: HTMLElement, toolbar: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inside = true;
  let pressed = false;
  let keyboardFocus = false;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const hide = () => {
    clear();
    if (!pressed && !keyboardFocus) player.setAttribute("data-toolbar-hidden", "");
  };
  const reveal = () => {
    clear();
    player.removeAttribute("data-toolbar-hidden");
    if (!pressed && !keyboardFocus) timer = setTimeout(hide, idleDelay);
  };
  const pointer = () => {
    inside = true;
    keyboardFocus = false;
    reveal();
  };
  const leave = () => {
    inside = false;
    hide();
  };
  const down = (event: PointerEvent) => {
    if (event.button === 0) pressed = true;
    keyboardFocus = false;
    reveal();
  };
  const release = () => {
    if (!pressed) return;
    pressed = false;
    if (inside) reveal();
    else hide();
  };
  const focus = (event: FocusEvent) => {
    keyboardFocus =
      event.target instanceof HTMLElement &&
      toolbar.contains(event.target) &&
      event.target.matches(":focus-visible");
    reveal();
  };
  const blur = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && toolbar.contains(event.relatedTarget)) return;
    keyboardFocus = false;
    if (inside) reveal();
    else hide();
  };
  const key = () => {
    keyboardFocus = toolbar.contains(document.activeElement);
    reveal();
  };
  const deactivate = () => {
    pressed = false;
    keyboardFocus = false;
    inside = false;
    hide();
  };
  const visibility = () => {
    if (document.hidden) deactivate();
  };

  player.addEventListener("pointerenter", pointer);
  player.addEventListener("pointermove", pointer);
  player.addEventListener("pointerleave", leave);
  player.addEventListener("focusin", focus);
  player.addEventListener("focusout", blur);
  player.addEventListener("keydown", key, true);
  toolbar.addEventListener("pointerdown", down);
  toolbar.addEventListener("lostpointercapture", release);
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
  window.addEventListener("focus", reveal);
  window.addEventListener("blur", deactivate);
  document.addEventListener("visibilitychange", visibility);
  reveal();

  return () => {
    clear();
    player.removeAttribute("data-toolbar-hidden");
    player.removeEventListener("pointerenter", pointer);
    player.removeEventListener("pointermove", pointer);
    player.removeEventListener("pointerleave", leave);
    player.removeEventListener("focusin", focus);
    player.removeEventListener("focusout", blur);
    player.removeEventListener("keydown", key, true);
    toolbar.removeEventListener("pointerdown", down);
    toolbar.removeEventListener("lostpointercapture", release);
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    window.removeEventListener("focus", reveal);
    window.removeEventListener("blur", deactivate);
    document.removeEventListener("visibilitychange", visibility);
  };
}
