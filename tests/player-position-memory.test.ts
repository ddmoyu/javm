import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { window as nativeWindow } from "@neutralinojs/lib";
import { trackPlayerWindowPosition } from "../frontend/src/platform/neutralino/playerPreferences";
import { storedPlayerPreferences } from "../frontend/src/services/playback/PlayerPreferences";
import { startPlayerDrag } from "../frontend/src/platform/neutralino/playerFrame";

vi.mock("@neutralinojs/lib", () => ({
  window: {
    getPosition: vi.fn(),
    isMaximized: vi.fn(),
    isMinimized: vi.fn(),
    isFullScreen: vi.fn(),
    move: vi.fn(),
  },
}));
vi.mock("../frontend/src/platform/neutralino/settingsStorage", () => ({
  nativeSettingsStorage: vi.fn(),
}));
vi.mock("../frontend/src/platform/neutralino/library", () => ({ NativeLibraryPort: vi.fn() }));
vi.mock("../frontend/src/platform/neutralino/windowFrame", () => ({ refreshWindowState: vi.fn() }));

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { devicePixelRatio: 1 }));
  vi.stubGlobal("innerWidth", 1000);
  vi.mocked(nativeWindow.getPosition).mockResolvedValue({ x: 100, y: 200 });
  vi.mocked(nativeWindow.isMaximized).mockResolvedValue(false);
  vi.mocked(nativeWindow.isMinimized).mockResolvedValue(false);
  vi.mocked(nativeWindow.isFullScreen).mockResolvedValue(false);
  vi.mocked(nativeWindow.move).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("原生播放器位置记忆", () => {
  it("普通移动会保存，未移动的旧窗口关闭不会覆盖另一个窗口的新位置", async () => {
    const write = vi.fn(async () => {});
    const preferences = storedPlayerPreferences({ read: async () => null, write });
    const save = trackPlayerWindowPosition(preferences, vi.fn());
    await tick();
    await save();
    expect(write).not.toHaveBeenCalled();
    vi.mocked(nativeWindow.getPosition).mockResolvedValue({ x: -1200, y: 120 });
    await save();
    expect(await preferences.read()).toEqual({ volume: 1, position: { x: -1200, y: 120 } });
    await preferences.update({ position: { x: 400, y: 300 } });
    await save();
    expect(await preferences.read()).toEqual({ volume: 1, position: { x: 400, y: 300 } });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("最小化、最大化和全屏时不写位置，恢复普通窗口后再保存", async () => {
    const write = vi.fn(async () => {});
    const preferences = storedPlayerPreferences({ read: async () => null, write });
    const save = trackPlayerWindowPosition(preferences, vi.fn());
    await tick();
    vi.mocked(nativeWindow.getPosition).mockResolvedValue({ x: -32000, y: -32000 });
    for (const state of [
      nativeWindow.isMaximized,
      nativeWindow.isMinimized,
      nativeWindow.isFullScreen,
    ]) {
      vi.mocked(state).mockResolvedValueOnce(true);
      await save();
    }
    expect(write).not.toHaveBeenCalled();
    vi.mocked(nativeWindow.getPosition).mockResolvedValue({ x: 800, y: 300 });
    await save();
    expect(write).toHaveBeenCalledExactlyOnceWith({ volume: 1, position: { x: 800, y: 300 } });
  });

  it("位置写入失败会反馈，下一次失焦可以重试", async () => {
    const write = vi.fn(async () => {});
    write.mockRejectedValueOnce(new Error("safe mock position failure"));
    const preferences = storedPlayerPreferences({ read: async () => null, write });
    const report = vi.fn();
    const save = trackPlayerWindowPosition(preferences, report);
    await tick();
    vi.mocked(nativeWindow.getPosition).mockResolvedValue({ x: 600, y: 300 });
    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
    await save();
    expect(await preferences.read()).toEqual({ volume: 1, position: { x: 600, y: 300 } });
  });

  it("松开鼠标后等待最终原生移动完成，随后仅保存一次", async () => {
    let moved!: () => void;
    vi.mocked(nativeWindow.move).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          moved = resolve;
        }),
    );
    const saved = vi.fn();
    const drag = startPlayerDrag(
      { screenX: 400, screenY: 250, clientX: 100, clientY: 20 },
      false,
      vi.fn(),
      saved,
    );
    drag.move(450, 300);
    await tick();
    drag.finish();
    expect(saved).not.toHaveBeenCalled();
    moved();
    await tick();
    expect(nativeWindow.move).toHaveBeenCalledExactlyOnceWith(150, 250);
    expect(saved).toHaveBeenCalledOnce();
    drag.finish();
    expect(saved).toHaveBeenCalledOnce();
  });
});
