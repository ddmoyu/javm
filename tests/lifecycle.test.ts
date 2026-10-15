import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BackgroundSettingsService } from "../frontend/src/services/settings/BackgroundSettingsService";
import type { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import { deferred } from "./helpers/deferred";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  exit: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  setTray: vi.fn(),
  showNotification: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  app: { exit: native.exit },
  window: { hide: native.hide, show: native.show, focus: native.focus },
  os: {
    setTray: native.setTray,
    showNotification: native.showNotification,
    showMessageBox: native.showMessageBox,
  },
  events: {
    on: async (name: string, callback: (event: unknown) => void) =>
      native.handlers.set(name, callback),
  },
  MessageBoxChoice: { OK: "OK" },
  Icon: { ERROR: "ERROR" },
}));

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { NL_OS: "Windows" }));
  vi.resetModules();
  vi.resetAllMocks();
  native.handlers.clear();
  for (const mock of [
    native.exit,
    native.hide,
    native.show,
    native.focus,
    native.setTray,
    native.showNotification,
    native.showMessageBox,
  ])
    mock.mockResolvedValue(undefined);
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
});

async function fixture(runInBackground = true) {
  const lifecycle = await import("../frontend/src/platform/neutralino/lifecycle");
  const settings = new BackgroundSettingsService({
    read: async () => ({ runInBackground }),
    write: async () => {},
  });
  const stopServices = vi.fn(async () => {});
  const shutdown = vi.fn(async (beforeDatabaseClose?: () => Promise<void>) => {
    await beforeDatabaseClose?.();
  });
  lifecycle.initializeLifecycle({ shutdown } as unknown as DownloadService, settings, stopServices);
  return { ...lifecycle, settings, stopServices, shutdown };
}

describe("关闭主窗口与显式退出", () => {
  it("语言切换更新托盘，页面卸载后停止订阅", async () => {
    await fixture();
    const { setLocale } = await import("../frontend/src/i18n/core");
    setLocale("en");
    await vi.waitFor(() =>
      expect(native.setTray).toHaveBeenLastCalledWith(
        expect.objectContaining({
          menuItems: expect.arrayContaining([
            expect.objectContaining({ id: "exit", text: "Quit JAVM" }),
          ]),
        }),
      ),
    );
    window.dispatchEvent(new Event("pagehide"));
    native.setTray.mockClear();
    setLocale("ja");
    expect(native.setTray).not.toHaveBeenCalled();
  });

  it("默认关闭只隐藏主窗口，不中断任务；系统关闭事件使用相同规则", async () => {
    const app = await fixture();
    await app.closeMainWindow();
    native.handlers.get("windowClose")?.({});
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledTimes(2));
    expect(app.stopServices).not.toHaveBeenCalled();
    expect(app.shutdown).not.toHaveBeenCalled();
    expect(native.exit).not.toHaveBeenCalled();
  });

  it("关闭后台运行后停止应用服务和下载，最后退出宿主", async () => {
    const app = await fixture(false);
    const order: string[] = [];
    app.stopServices.mockImplementation(async () => {
      order.push("services");
    });
    app.shutdown.mockImplementation(async (beforeDatabaseClose) => {
      order.push("downloads");
      await beforeDatabaseClose?.();
    });
    native.exit.mockImplementation(async () => {
      order.push("exit");
    });
    await app.closeMainWindow();
    expect(order).toEqual(["downloads", "services", "exit"]);
    expect(native.hide).not.toHaveBeenCalled();
  });

  it("设置立即生效，系统关闭事件在关闭后台运行后直接退出", async () => {
    const app = await fixture();
    await app.settings.setRunInBackground(false);
    native.handlers.get("windowClose")?.({});
    await vi.waitFor(() => expect(native.exit).toHaveBeenCalledTimes(1));
    expect(app.shutdown).toHaveBeenCalledTimes(1);
    expect(native.hide).not.toHaveBeenCalled();
  });

  it("托盘菜单退出始终停止任务，退出期间重复关闭不会隐藏窗口或重复清理", async () => {
    const app = await fixture();
    const cleanup = deferred<void>();
    app.stopServices.mockReturnValue(cleanup.promise);
    native.handlers.get("trayMenuItemClicked")?.({ detail: { id: "exit" } });
    await app.closeMainWindow();
    await app.exitApplication();
    expect(native.hide).not.toHaveBeenCalled();
    expect(native.exit).not.toHaveBeenCalled();
    expect(app.stopServices).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await vi.waitFor(() => expect(native.exit).toHaveBeenCalledTimes(1));
  });

  it("托盘创建未完成时等待；创建失败则清理退出，避免留下不可访问的应用", async () => {
    const tray = deferred<void>();
    native.setTray.mockReturnValueOnce(tray.promise);
    const app = await fixture();
    const close = app.closeMainWindow();
    await Promise.resolve();
    expect(native.exit).not.toHaveBeenCalled();
    tray.reject(new Error("托盘不可用"));
    await close;
    expect(app.shutdown).toHaveBeenCalledTimes(1);
    expect(native.exit).toHaveBeenCalledTimes(1);
    expect(native.hide).not.toHaveBeenCalled();
  });

  it("关闭后台运行后不等待托盘初始化", async () => {
    native.setTray.mockReturnValueOnce(new Promise(() => {}));
    const app = await fixture(false);
    await app.closeMainWindow();
    expect(native.exit).toHaveBeenCalledTimes(1);
  });

  it("任务收尾失败不提前退出，错误可见且允许再次关闭重试", async () => {
    const app = await fixture(false);
    app.shutdown.mockRejectedValueOnce(new Error("进程尚未停止"));
    native.handlers.get("windowClose")?.({});
    await vi.waitFor(() => expect(native.showMessageBox).toHaveBeenCalledTimes(1));
    expect(native.exit).not.toHaveBeenCalled();
    expect(native.show).toHaveBeenCalled();
    await app.closeMainWindow();
    expect(native.exit).toHaveBeenCalledTimes(1);
    expect(app.shutdown).toHaveBeenCalledTimes(2);
  });
});
