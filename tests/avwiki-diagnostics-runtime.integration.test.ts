import { describe, expect, it } from "vite-plus/test";
import {
  readAvwikiBrowserPage,
  type AvwikiBrowserDiagnostics,
} from "../frontend/src/services/catalog/avwikiBrowser";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "详细诊断运行验证（真实隐藏宿主、安全合成数据）",
  () => {
    it("采样主页面及子页面，记录标准错误码但不干预模拟验证", async () => {
      const url = "https://avwikidb.com/actor/1/";
      let documents = 0;
      let diagnostic: AvwikiBrowserDiagnostics | undefined;
      const statuses: number[] = [];
      const result = await withSafeCatalogBrowser(
        (request) => {
          if (request.href === url) {
            const challenge = ++documents === 1;
            return {
              status: challenge ? 403 : 200,
              headers: challenge ? { "cf-mitigated": "challenge" } : undefined,
              body: challenge
                ? `<main>Safe verification fixture</main><script>
            const frame=document.createElement('iframe');frame.src='https://challenges.cloudflare.com/safe-diagnostic';document.body.append(frame);
            addEventListener('message',e=>{if(e.origin==='https://challenges.cloudflare.com'&&e.data==='safe-ready')setTimeout(()=>location.reload(),2400)});
          </script>`
                : "<main>Safe diagnostic result</main>",
            };
          }
          if (request.pathname === "/safe-diagnostic")
            return {
              body: `<input type="checkbox"><script>
        console.error('[Cloudflare Turnstile] Error: 600010.');
        console.log('SAFE_PRIVATE_MARKER must not appear in diagnostics');
        parent.postMessage('safe-ready','https://avwikidb.com');
      </script>`,
            };
          if (request.pathname === "/favicon.ico") return { status: 404, body: "" };
        },
        (browser, signal) =>
          readAvwikiBrowserPage(
            browser,
            url,
            signal,
            (response) => statuses.push(response.status),
            undefined,
            (value) => {
              diagnostic = value;
            },
          ),
      );
      expect(result).toBe("<main>Safe diagnostic result</main>");
      expect(statuses).toEqual([403, 200]);
      const detail = diagnostic?.detail;
      expect(detail?.turnstileCode).toBe("600010");
      expect(detail?.pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: expect.stringMatching(/^page-/),
            webdriver: false,
            visibility: "visible",
            focused: true,
          }),
          expect.objectContaining({
            target: expect.stringMatching(/^iframe-/),
            webdriver: false,
            visibleCheckboxes: 1,
          }),
        ]),
      );
      expect(detail?.traces).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "challenge_frame", status: 200 })]),
      );
      expect(detail?.probeErrors).toBe(0);
      expect(JSON.stringify(detail)).not.toMatch(
        /SAFE_PRIVATE_MARKER|avwikidb|https:|safe-diagnostic/,
      );
    }, 25000);
  },
);
