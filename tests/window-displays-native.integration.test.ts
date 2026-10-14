import { mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { MediaHost } from "./helpers/mediaHost";
import type { WindowDisplay } from "../frontend/src/contracts/window";

it.runIf(process.platform === "win32" && process.env.JAVM_WINDOW_INTEGRATION === "1")(
  "通过正式 Extension 查询物理显示区域，不创建或打开数据库",
  async () => {
    const root = await mkdtemp(path.resolve(".tmp/window-displays-safe-"));
    const host = new MediaHost();
    try {
      await host.start(path.join(root, "unused.sqlite3"));
      const displays = await host.request<WindowDisplay[]>("window.displays");
      expect(displays.length).toBeGreaterThan(0);
      expect(displays.filter((display) => display.primary)).toHaveLength(1);
      for (const { bounds, workArea } of displays) {
        for (const rect of [bounds, workArea]) {
          expect(Object.values(rect).every(Number.isFinite)).toBe(true);
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
        }
        expect(workArea.x).toBeGreaterThanOrEqual(bounds.x);
        expect(workArea.y).toBeGreaterThanOrEqual(bounds.y);
        expect(workArea.x + workArea.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(workArea.y + workArea.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
      expect(await readdir(root)).toEqual([]);
    } finally {
      await host.close();
    }
  },
  15000,
);
