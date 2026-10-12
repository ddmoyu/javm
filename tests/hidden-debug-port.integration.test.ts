import { describe, expect, it } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "非零调试端口（真实隐藏宿主、安全合成数据）",
  () => {
    it("启动器发布所属 Job 的端点，主页面与子页面保持原生浏览器状态", async () => {
      // 域名仅用于校验；全部响应由 CDP 合成，DNS 禁用，绝不访问真实来源。
      const url = "https://avwikidb.com/actor/1/";
      let documents = 0;
      const statuses: number[] = [];
      const result = await withSafeCatalogBrowser(
        (request) => {
          if (request.href === url) {
            const challenge = ++documents === 1;
            return {
              status: challenge ? 403 : 200,
              headers: challenge ? { "cf-mitigated": "challenge" } : undefined,
              body: challenge
                ? `<main>Safe port check</main><script>
                    if (navigator.webdriver === false) {
                      const frame = document.createElement('iframe');
                      frame.src = 'https://challenges.cloudflare.com/safe-port-frame';
                      document.body.append(frame);
                      addEventListener('message', e => {
                        if (e.origin === 'https://challenges.cloudflare.com' && e.data === 'safe-ready') location.reload();
                      });
                    }
                  </script>`
                : "<main>Safe port check passed</main>",
            };
          }
          if (request.pathname === "/safe-port-frame")
            return {
              body: `<script>if (navigator.webdriver === false) requestAnimationFrame(() => parent.postMessage('safe-ready', 'https://avwikidb.com'))</script>`,
            };
          if (request.pathname === "/favicon.ico") return { status: 404, body: "" };
        },
        (browser, signal) =>
          readAvwikiBrowserPage(browser, url, signal, (response) => statuses.push(response.status)),
      );
      expect(result).toBe("<main>Safe port check passed</main>");
      expect(statuses).toEqual([403, 200]);
      expect(documents).toBe(2);
    }, 25000);
  },
);
