import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { window as nativeWindow } from "@neutralinojs/lib";
import { bindWindowDragRegion } from "../frontend/src/platform/neutralino/windowDrag";
import {
  getWindowState,
  toggleWindowMaximize,
} from "../frontend/src/platform/neutralino/windowFrame";

const fixture = vi.hoisted(() => ({ maximized: false }));
vi.mock("@neutralinojs/lib", () => ({
  events: { on: vi.fn() },
  window: {
    beginDrag: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => fixture.maximized),
    isFullScreen: vi.fn(async () => false),
    maximize: vi.fn(async () => {
      fixture.maximized = true;
    }),
    unmaximize: vi.fn(async () => {
      fixture.maximized = false;
    }),
  },
}));

class Region extends EventTarget {
  captured = new Set<number>();
  interactive = false;
  closest() {
    return this.interactive ? this : null;
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
}
let region: Region;
let cleanup: () => void;
const notice = vi.fn();
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const pointer = (type: string, values: Record<string, number | boolean> = {}) => {
  region.dispatchEvent(
    Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1,
      isPrimary: true,
      screenX: 100,
      screenY: 100,
      button: 0,
      buttons: 1,
      ...values,
    }),
  );
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.maximized = false;
  vi.stubGlobal("Element", Region);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  region = new Region();
  cleanup = bindWindowDragRegion(region as unknown as HTMLElement, notice);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("标题栏双击最大化，再次双击还原；按下和轻微抖动不启动原生拖动", async () => {
  for (const maximized of [true, false]) {
    for (let click = 0; click < 2; click++) {
      pointer("pointerdown");
      pointer("pointermove", { screenX: 102, screenY: 101 });
      pointer("pointerup", { buttons: 0 });
    }
    pointer("dblclick", { buttons: 0 });
    await flush();
    expect(getWindowState().maximized).toBe(maximized);
  }
  expect(nativeWindow.beginDrag).not.toHaveBeenCalled();
  expect(nativeWindow.maximize).toHaveBeenCalledTimes(1);
  expect(nativeWindow.unmaximize).toHaveBeenCalledTimes(1);
  expect(region.captured.size).toBe(0);
});

it("移动达到阈值后只开始一次原生拖动，取消与失焦清理待拖动手势", async () => {
  pointer("pointerdown");
  pointer("pointermove", { screenX: 110 });
  pointer("pointermove", { screenX: 140 });
  await flush();
  expect(nativeWindow.beginDrag).toHaveBeenCalledExactlyOnceWith(110, 100);
  expect(region.captured.size).toBe(0);
  pointer("pointerdown");
  window.dispatchEvent(new Event("blur"));
  pointer("pointermove", { screenX: 140 });
  pointer("pointerdown");
  pointer("pointercancel");
  pointer("pointermove", { screenX: 140 });
  expect(nativeWindow.beginDrag).toHaveBeenCalledTimes(1);
});

it("右键、交互控件和卸载后的手势不触发窗口操作", async () => {
  pointer("pointerdown", { button: 2 });
  pointer("pointermove", { screenX: 140 });
  pointer("dblclick", { button: 2 });
  region.interactive = true;
  pointer("pointerdown");
  pointer("pointermove", { screenX: 140 });
  pointer("dblclick");
  region.interactive = false;
  cleanup();
  pointer("pointerdown");
  pointer("pointermove", { screenX: 140 });
  pointer("dblclick");
  await flush();
  expect(nativeWindow.beginDrag).not.toHaveBeenCalled();
  expect(nativeWindow.maximize).not.toHaveBeenCalled();
});

it("最大化请求失败后反馈并允许重试，同时到达的操作不重复切换", async () => {
  vi.mocked(nativeWindow.maximize).mockRejectedValueOnce(new Error("Safe fixture failure"));
  pointer("dblclick");
  await flush();
  expect(notice).toHaveBeenCalledWith("窗口操作失败，请重试");
  const first = toggleWindowMaximize();
  expect(toggleWindowMaximize()).toBe(first);
  await first;
  expect(fixture.maximized).toBe(true);
  expect(nativeWindow.maximize).toHaveBeenCalledTimes(2);
});
