import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { window as nativeWindow } from "@neutralinojs/lib";
import { startPlayerDrag } from "../frontend/src/platform/neutralino/playerFrame";

vi.mock("@neutralinojs/lib", () => ({
  window: {
    move: vi.fn(async () => {}),
    getPosition: vi.fn(async () => ({ x: 100, y: 200 })),
    getSize: vi.fn(async () => ({ width: 960, height: 600 })),
    unmaximize: vi.fn(async () => {}),
  },
}));
vi.mock("../frontend/src/platform/neutralino/windowFrame", () => ({
  refreshWindowState: vi.fn(async () => {}),
}));
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const pointer = { screenX: 400, screenY: 250, clientX: 100, clientY: 20 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal("innerWidth", 1000);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native titlebar dragging", () => {
  it("leaves clicks and double clicks alone without entering the native move loop", async () => {
    const drag = startPlayerDrag(pointer, false, vi.fn());
    drag.move(402, 251);
    drag.finish();
    await flush();
    expect(nativeWindow.getPosition).not.toHaveBeenCalled();
    expect(nativeWindow.move).not.toHaveBeenCalled();
  });
  it("coalesces rapid motion while I/O is pending and applies the final position after release", async () => {
    let done!: (value: { x: number; y: number }) => void;
    vi.mocked(nativeWindow.getPosition).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const drag = startPlayerDrag(pointer, false, vi.fn());
    for (let step = 5; step <= 100; step++) drag.move(400 + step, 250 + step);
    drag.finish();
    expect(nativeWindow.getPosition).toHaveBeenCalledOnce();
    done({ x: 100, y: 200 });
    await flush();
    expect(nativeWindow.move).toHaveBeenCalledExactlyOnceWith(300, 400);
    drag.move(800, 800);
    await flush();
    expect(nativeWindow.move).toHaveBeenCalledOnce();
  });
  it("discards queued movement when the pointer gesture is cancelled", async () => {
    const drag = startPlayerDrag(pointer, false, vi.fn());
    drag.move(450, 300);
    drag.cancel();
    await flush();
    expect(nativeWindow.move).not.toHaveBeenCalled();
  });
  it("restores a maximized window and keeps the titlebar below the pointer", async () => {
    const drag = startPlayerDrag(pointer, true, vi.fn());
    drag.move(450, 300);
    await flush();
    expect(nativeWindow.unmaximize).toHaveBeenCalledOnce();
    expect(nativeWindow.move).toHaveBeenCalledExactlyOnceWith(804, 560);
  });
});
