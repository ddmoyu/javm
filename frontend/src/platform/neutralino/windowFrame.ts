import { events, window as nativeWindow } from "@neutralinojs/lib";

interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
  alwaysOnTop: boolean;
}

// Neutralino 没有置顶状态查询接口；窗口默认不置顶，之后只由本窗口切换。
let state: WindowState = { maximized: false, fullScreen: false, alwaysOnTop: false };
let initialized = false;
let revision = 0;
const listeners = new Set<() => void>();
let toggling: Promise<void> | undefined;

export const getWindowState = () => state;
export function subscribeWindowState(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function updateWindowState(next: WindowState) {
  revision += 1;
  document.documentElement.dataset.windowMaximized = String(next.maximized);
  document.documentElement.dataset.windowFullscreen = String(next.fullScreen);
  if (
    state.maximized === next.maximized &&
    state.fullScreen === next.fullScreen &&
    state.alwaysOnTop === next.alwaysOnTop
  )
    return;
  state = next;
  for (const listener of listeners) listener();
}

export async function refreshWindowState() {
  const request = ++revision;
  const [maximized, fullScreen] = await Promise.all([
    nativeWindow.isMaximized(),
    nativeWindow.isFullScreen(),
  ]);
  // 查询期间如果收到了更新的原生事件，不能用旧结果覆盖它。
  if (request === revision) updateWindowState({ ...state, maximized, fullScreen });
}

export function toggleWindowMaximize() {
  return (toggling ??= (async () => {
    const maximized = await nativeWindow.isMaximized();
    await (maximized ? nativeWindow.unmaximize() : nativeWindow.maximize());
    await refreshWindowState();
  })().finally(() => {
    toggling = undefined;
  }));
}

export async function toggleWindowAlwaysOnTop() {
  const next = !state.alwaysOnTop;
  await nativeWindow.setAlwaysOnTop(next);
  updateWindowState({ ...state, alwaysOnTop: next });
}

export function initializeWindowFrame() {
  if (initialized) return;
  initialized = true;
  const syncInitialState = () => {
    void refreshWindowState().catch(() => {});
  };
  // 跟随宿主事件，覆盖标题栏按钮、系统快捷键以及从最大化状态还原。
  void events.on("ready", syncInitialState);
  void events.on("windowMaximize", () => updateWindowState({ ...state, maximized: true }));
  void events.on("windowRestore", () => updateWindowState({ ...state, maximized: false }));
  void events.on("windowFullScreenEnter", () => updateWindowState({ ...state, fullScreen: true }));
  void events.on("windowFullScreenExit", () => updateWindowState({ ...state, fullScreen: false }));
  syncInitialState();
}
