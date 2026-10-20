import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: CustomEvent) => void>(),
  exit: vi.fn(),
  tray: vi.fn(),
  menu: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  app: { exit: mocks.exit },
  events: {
    on: vi.fn((name: string, listener: (event: CustomEvent) => void) => {
      mocks.listeners.set(name, listener);
      return Promise.resolve();
    }),
  },
  os: { setTray: mocks.tray, showMessageBox: vi.fn() },
  window: { setMainMenu: mocks.menu, hide: mocks.hide, show: mocks.show, focus: vi.fn() },
  MessageBoxChoice: { OK: 0 },
  Icon: { ERROR: 0 },
}));
vi.mock("../frontend/src/services/logging/events", () => ({
  flushLogs: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("../frontend/src/platform/neutralino/applicationInstance", () => ({
  stopApplicationLaunches: vi.fn(),
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.tray.mockResolvedValue(undefined);
  mocks.menu.mockResolvedValue(undefined);
  mocks.hide.mockResolvedValue(undefined);
  mocks.show.mockResolvedValue(undefined);
  mocks.exit.mockResolvedValue(undefined);
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
});

it("macOS 菜单退出等待后台任务收尾，再退出官方宿主", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { NL_OS: "Darwin" }));
  const lifecycle = await import("../frontend/src/platform/neutralino/lifecycle");
  let complete!: () => void;
  const shutdown = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  lifecycle.initializeLifecycle(
    { shutdown } as unknown as Parameters<typeof lifecycle.initializeLifecycle>[0],
    { shouldRunInBackground: async () => true } as Parameters<
      typeof lifecycle.initializeLifecycle
    >[1],
  );
  expect(mocks.menu).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        menuItems: expect.arrayContaining([
          expect.objectContaining({ id: "javm-quit", shortcut: "q" }),
        ]),
      }),
    ]),
  );
  mocks.listeners.get("mainMenuItemClicked")!({ detail: { id: "javm-quit" } } as CustomEvent);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(mocks.exit).not.toHaveBeenCalled();
  complete();
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledTimes(1));
});

it("Linux 托盘不可用时关窗也会等待下载关闭，而不是留下不可见进程", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { NL_OS: "Linux" }));
  mocks.tray.mockRejectedValue(new Error("safe missing tray"));
  const lifecycle = await import("../frontend/src/platform/neutralino/lifecycle");
  const shutdown = vi.fn().mockResolvedValue(undefined);
  lifecycle.initializeLifecycle(
    { shutdown } as unknown as Parameters<typeof lifecycle.initializeLifecycle>[0],
    { shouldRunInBackground: async () => true } as Parameters<
      typeof lifecycle.initializeLifecycle
    >[1],
  );
  await lifecycle.closeMainWindow();
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(mocks.exit).toHaveBeenCalledTimes(1);
  expect(mocks.hide).not.toHaveBeenCalled();
  expect(mocks.menu).not.toHaveBeenCalled();
});
