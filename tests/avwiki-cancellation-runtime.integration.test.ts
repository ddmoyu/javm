import { describe, expect, it } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import type { AvwikiBrowserDiagnostics } from "../frontend/src/services/catalog/avwikiBrowser";
import { HiddenWebviewError } from "../frontend/src/platform/neutralino/hiddenWebview";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

// 地址仅用于正式校验。DNS 被阻断，所有响应和网络取消由安全 fixture 提供。
const url = "https://avwikidb.com/actor/1/";
describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "请求取消处理（真实隐藏宿主、安全合成数据）",
  () => {
    it.each([true, false])(
      "PAT 401 后的普通验证：完成=%s",
      async (completes) => {
        let documents = 0;
        let diagnostic: AvwikiBrowserDiagnostics | undefined;
        const statuses: number[] = [];
        const result = await withSafeCatalogBrowser(
          (request) => {
            if (request.pathname === "/actor/1/") {
              const challenge = ++documents === 1;
              return {
                status: challenge ? 403 : 200,
                headers: challenge ? { "cf-mitigated": "challenge" } : undefined,
                body: challenge
                  ? `<!doctype html><html><body><main>Safe PAT probe</main><script>
                  fetch('/cdn-cgi/challenge-platform/h/b/pat/safe-probe').then(response=>{
                    if(response.status!==401)throw new Error('Unexpected safe probe result');
                    ${completes ? "location.reload();" : ""}
                  });
                  </script></body></html>`
                  : "<main>Safe verification completed</main>",
              };
            }
            if (request.pathname === "/cdn-cgi/challenge-platform/h/b/pat/safe-probe")
              return { status: 401, body: "Safe probe unavailable" };
            if (request.pathname === "/favicon.ico") return { status: 404, body: "" };
          },
          async (browser, signal) => {
            const abort = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            browser.on((event) => {
              if (
                !completes &&
                event.method === "Network.responseReceived" &&
                (event.params.response as { status?: number })?.status === 401
              )
                timer = setTimeout(
                  () => abort.abort(new HiddenWebviewError("timeout", "read")),
                  500,
                );
            });
            try {
              return await readAvwikiBrowserPage(
                browser,
                url,
                AbortSignal.any([signal, abort.signal]),
                (response) => statuses.push(response.status),
                undefined,
                (value) => {
                  diagnostic = value;
                },
              );
            } catch (error) {
              if (completes) throw error;
              expect(error).toMatchObject({ code: "timeout" });
              return undefined;
            } finally {
              clearTimeout(timer);
            }
          },
        );
        expect(diagnostic).toMatchObject({
          pat401Responses: 1,
          failedResources: 0,
          lastNetworkError: "",
        });
        expect(statuses).toEqual(completes ? [403, 200] : [403]);
        expect(documents).toBe(completes ? 2 : 1);
        expect(result).toBe(completes ? "<main>Safe verification completed</main>" : undefined);
      },
      20000,
    );

    it.each(["取消后重载", "取消后持续验证", "连接失败后取消"])(
      "%s",
      async (scenario) => {
        let documents = 0;
        let diagnostic: AvwikiBrowserDiagnostics | undefined;
        const statuses: number[] = [];
        const networkErrors: string[] = [];
        const result = await withSafeCatalogBrowser(
          (request) => {
            if (request.pathname === "/actor/1/") {
              const challenge = ++documents === 1;
              return {
                status: challenge ? 403 : 200,
                headers: challenge ? { "cf-mitigated": "challenge" } : undefined,
                body: challenge
                  ? `<!doctype html><html><body><main>Safe check pending</main><script>
                    (async()=>{
                      ${scenario === "连接失败后取消" ? "await fetch('/safe-connection').catch(()=>{});" : ""}
                      await fetch('/safe-cancel').catch(()=>{});
                      ${scenario === "取消后持续验证" ? "" : "location.reload();"}
                    })();
                    </script></body></html>`
                  : "<main>Safe cancellation completed</main>",
              };
            }
            if (request.pathname === "/safe-cancel") return { body: "", failure: "Aborted" };
            if (request.pathname === "/safe-connection")
              return { body: "", failure: "ConnectionFailed" };
            if (request.pathname === "/favicon.ico") return { body: "", status: 404 };
          },
          async (browser, signal) => {
            const abort = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            browser.on((event) => {
              if (event.method === "Network.loadingFailed") {
                networkErrors.push(String(event.params.errorText));
                // 先让页面的取消事件完成，再模拟原定时限结束；不把退出当成取消来源。
                if (scenario === "取消后持续验证" && event.params.errorText === "net::ERR_ABORTED")
                  timer = setTimeout(
                    () => abort.abort(new HiddenWebviewError("timeout", "read")),
                    500,
                  );
              }
            });
            try {
              return await readAvwikiBrowserPage(
                browser,
                url,
                AbortSignal.any([signal, abort.signal]),
                (response) => statuses.push(response.status),
                undefined,
                (value) => {
                  diagnostic = value;
                },
              );
            } catch (error) {
              if (scenario !== "取消后持续验证") throw error;
              expect(error).toMatchObject({ code: "timeout" });
              return undefined;
            } finally {
              clearTimeout(timer);
            }
          },
        );
        expect(networkErrors).toContain("net::ERR_ABORTED");
        expect(diagnostic).toMatchObject({
          canceledResources: 1,
          lastCanceledType: "Fetch",
          lastCanceledSource: "source",
          failedResources: scenario === "连接失败后取消" ? 1 : 0,
          lastNetworkError: scenario === "连接失败后取消" ? "ERR_CONNECTION_FAILED" : "",
        });
        if (scenario === "取消后持续验证") {
          expect(result).toBeUndefined();
          expect(statuses).toEqual([403]);
          expect(documents).toBe(1);
        } else {
          expect(result).toBe("<main>Safe cancellation completed</main>");
          expect(statuses).toEqual([403, 200]);
          expect(documents).toBe(2);
        }
      },
      20000,
    );
  },
);
