import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import type { DownloadEngine, DownloadRepository } from "../frontend/src/services/downloads/ports";
import { BackgroundSettingsService } from "../frontend/src/services/settings/BackgroundSettingsService";
import { deferred } from "./helpers/deferred";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  exit: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  setTray: vi.fn(),
  showMessageBox: vi.fn(),
  stopLaunches: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  app: { exit: native.exit },
  window: { hide: native.hide, show: native.show, focus: native.focus },
  os: { setTray: native.setTray, showMessageBox: native.showMessageBox },
  events: {
    on: async (name: string, callback: (event: unknown) => void) =>
      native.handlers.set(name, callback),
  },
  MessageBoxChoice: { OK: "OK" },
  Icon: { ERROR: "ERROR" },
}));
vi.mock("../frontend/src/platform/neutralino/applicationInstance", () => ({
  stopApplicationLaunches: native.stopLaunches,
}));
vi.mock("../frontend/src/services/logging/events", () => ({
  logEvent: vi.fn(),
  flushLogs: async () => true,
}));

beforeEach(() => {
  vi.stubGlobal("window", { NL_OS: "Windows" });
  vi.resetModules();
  vi.resetAllMocks();
  native.handlers.clear();
  for (const fn of [
    native.exit,
    native.hide,
    native.show,
    native.focus,
    native.setTray,
    native.showMessageBox,
  ])
    fn.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  let closed = false;
  const close = vi.fn(async () => {
    closed = true;
  });
  const repository: DownloadRepository = {
    load: async () => ({ tasks: [], settings: { directory: "C:\\JAVM-Safe" } }),
    save: async () => {},
    remove: async () => {},
    saveSettings: async () => {},
    close,
  };
  const engine: DownloadEngine = {
    defaultDirectory: async () => "C:\\JAVM-Safe",
    outputSize: async () => null,
    run: async () => {},
    open: async () => {},
    checkTools: async () => [],
  };
  const downloads = new DownloadService(repository, engine);
  await downloads.initialize();
  const settings = new BackgroundSettingsService({ read: async () => null, write: async () => {} });
  const stopServices = vi.fn(async () => {
    if (closed) throw new Error("共享数据库扩展已提前关闭");
  });
  const lifecycle = await import("../frontend/src/platform/neutralino/lifecycle");
  lifecycle.initializeLifecycle(downloads, settings, stopServices);
  await Promise.resolve();
  return { ...lifecycle, downloads, close, stopServices };
}

describe("托盘退出与共享数据库收尾", () => {
  it("先停止任务并完成仍需数据库的服务收尾，最后关闭扩展和宿主", async () => {
    const app = await fixture();
    await app.exitApplication();
    expect(app.stopServices).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(native.exit).toHaveBeenCalledTimes(1);
    expect(native.stopLaunches.mock.invocationCallOrder[0]).toBeLessThan(
      app.stopServices.mock.invocationCallOrder[0]!,
    );
    expect(app.stopServices.mock.invocationCallOrder[0]).toBeLessThan(
      app.close.mock.invocationCallOrder[0]!,
    );
    expect(app.close.mock.invocationCallOrder[0]).toBeLessThan(
      native.exit.mock.invocationCallOrder[0]!,
    );
  });

  it("点击后立即显示正在退出，重复点击不重复清理，等待完成后才退出", async () => {
    const app = await fixture();
    const cleanup = deferred<void>();
    app.stopServices.mockReturnValueOnce(cleanup.promise);
    native.handlers.get("trayMenuItemClicked")?.({ detail: { id: "exit" } });
    await vi.waitFor(() => expect(app.stopServices).toHaveBeenCalledTimes(1));
    expect(native.setTray).toHaveBeenLastCalledWith(
      expect.objectContaining({
        menuItems: expect.arrayContaining([
          expect.objectContaining({ id: "exit", text: "正在退出…", isDisabled: true }),
        ]),
      }),
    );
    await app.exitApplication();
    await app.closeMainWindow();
    expect(app.close).not.toHaveBeenCalled();
    expect(native.exit).not.toHaveBeenCalled();
    expect(native.hide).not.toHaveBeenCalled();
    cleanup.resolve();
    await vi.waitFor(() => expect(native.exit).toHaveBeenCalledTimes(1));
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it("收尾失败保留共享扩展，恢复退出入口并允许重试", async () => {
    const app = await fixture();
    app.stopServices.mockRejectedValueOnce(new Error("安全样例：收尾暂未完成"));
    native.handlers.get("trayMenuItemClicked")?.({ detail: { id: "exit" } });
    await vi.waitFor(() => expect(native.showMessageBox).toHaveBeenCalledTimes(1));
    expect(app.close).not.toHaveBeenCalled();
    expect(native.exit).not.toHaveBeenCalled();
    expect(native.setTray).toHaveBeenLastCalledWith(
      expect.objectContaining({
        menuItems: expect.arrayContaining([
          expect.objectContaining({ id: "exit", text: "退出 JAVM", isDisabled: false }),
        ]),
      }),
    );
    await app.exitApplication();
    expect(app.stopServices).toHaveBeenCalledTimes(2);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(native.exit).toHaveBeenCalledTimes(1);
  });
});
