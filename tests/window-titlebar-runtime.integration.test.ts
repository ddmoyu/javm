import path from "node:path";
import { build } from "vite-plus";
import { expect, it } from "vite-plus/test";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

it.runIf(process.platform === "win32" && process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "隐藏 WebView2 的真实双击事件可切换标题栏状态，原生拖动只在移动后触发",
  async () => {
    const bundle = await build({
      configFile: false,
      publicDir: false,
      logLevel: "error",
      plugins: [
        {
          name: "safe-window-api",
          enforce: "pre",
          resolveId(source) {
            if (source === "@neutralinojs/lib") return "\0safe-window-api";
          },
          load(id) {
            if (id !== "\0safe-window-api") return;
            // 仅验证浏览器手势到正式窗口 API 的调用，不显示、移动或最大化真实宿主。
            return `
            const calls = globalThis.safeTitlebarCalls = { maximize:0, restore:0, drag:0 };
            let maximized = false;
            export const events = { on: async () => {} };
            export const window = {
              isMaximized: async () => maximized,
              isFullScreen: async () => false,
              maximize: async () => {calls.maximize++; maximized=true},
              unmaximize: async () => {calls.restore++; maximized=false},
              beginDrag: async () => {calls.drag++}
            };
          `;
          },
        },
      ],
      build: {
        write: false,
        lib: {
          entry: path.resolve("frontend/src/platform/neutralino/windowDrag.ts"),
          formats: ["iife"],
          name: "SafeTitlebar",
        },
      },
    });
    const output = Array.isArray(bundle) ? bundle[0] : bundle;
    if (!output || !("output" in output)) throw new Error("Unexpected fixture bundle");
    const chunk = output.output.find((entry) => entry.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing fixture script");
    if (!chunk.code.includes("safeTitlebarCalls")) throw new Error("Missing safe window API");
    await withSafeCatalogBrowser(
      () => {
        throw new Error("Titlebar fixture must not request network resources");
      },
      async (browser) => {
        const targets = await browser.send("Target.getTargets");
        const page = (targets.targetInfos as { type: string; targetId: string }[]).find(
          (target) => target.type === "page",
        );
        if (!page) throw new Error("Missing fixture page");
        const attached = await browser.send("Target.attachToTarget", {
          targetId: page.targetId,
          flatten: true,
        });
        const session = String(attached.sessionId);
        // 宿主的初始 about:blank 导航完成后再装载夹具，避免初始导航清空脚本环境。
        await browser.send("Page.enable", {}, session);
        await browser.send("Page.navigate", { url: "about:blank#safe-titlebar" }, session);
        await browser.send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: 800,
            height: 600,
            deviceScaleFactor: 1,
            mobile: false,
          },
          session,
        );
        await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session);
        const evaluate = async (expression: string) => {
          const response = await browser.send(
            "Runtime.evaluate",
            {
              expression,
              returnByValue: true,
              awaitPromise: true,
            },
            session,
          );
          if (response.exceptionDetails)
            throw new Error(
              `Safe titlebar fixture failed: ${JSON.stringify(response.exceptionDetails)}`,
            );
          return (response.result as { value: unknown }).value;
        };
        await evaluate(
          "new Promise(resolve => document.readyState === 'complete' ? resolve(true) : addEventListener('load', () => resolve(true), {once:true}))",
        );
        await evaluate(`${chunk.code}
          document.body.style.margin = '0';
          const bar = document.createElement('div');
          bar.style.cssText = 'width:700px;height:34px;user-select:none';
          bar.textContent = 'Safe title';
          document.body.append(bar);
          globalThis.titlebarNotices = [];
          globalThis.disposeTitlebar = SafeTitlebar.bindWindowDragRegion(bar, message => titlebarNotices.push(message));
        `);
        const mouse = async (type: string, x: number, buttons: number, clickCount = 1) => {
          await browser.send(
            "Input.dispatchMouseEvent",
            {
              type,
              x,
              y: 18,
              button: type === "mouseMoved" ? "none" : "left",
              buttons,
              clickCount,
            },
            session,
          );
        };
        const doubleClick = async () => {
          for (const clickCount of [1, 2]) {
            await mouse("mousePressed", 120, 1, clickCount);
            await mouse("mouseReleased", 120, 0, clickCount);
          }
        };
        await doubleClick();
        expect(
          await evaluate(
            "({...safeTitlebarCalls, maximized:document.documentElement.dataset.windowMaximized})",
          ),
        ).toEqual({ maximize: 1, restore: 0, drag: 0, maximized: "true" });
        await doubleClick();
        expect(
          await evaluate(
            "({...safeTitlebarCalls, maximized:document.documentElement.dataset.windowMaximized})",
          ),
        ).toEqual({ maximize: 1, restore: 1, drag: 0, maximized: "false" });
        await mouse("mousePressed", 120, 1);
        await mouse("mouseMoved", 122, 1);
        expect(await evaluate("safeTitlebarCalls.drag")).toBe(0);
        await mouse("mouseMoved", 140, 1);
        await mouse("mouseMoved", 170, 1);
        await mouse("mouseReleased", 170, 0);
        expect(await evaluate("safeTitlebarCalls.drag")).toBe(1);
        await evaluate("disposeTitlebar()");
        await doubleClick();
        expect(await evaluate("safeTitlebarCalls")).toEqual({ maximize: 1, restore: 1, drag: 1 });
        expect(await evaluate("titlebarNotices")).toEqual([]);
      },
    );
  },
  25000,
);
