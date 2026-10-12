import { describe, expect, it } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import type { AvwikiBrowserDiagnostics } from "../frontend/src/services/catalog/avwikiBrowser";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "封闭 Shadow DOM 人工验证识别（隐藏宿主、安全 mock）",
  () => {
    const url = "https://avwikidb.com/actor/1/";
    const challengePath = "/cdn-cgi/challenge-platform/safe-interaction";
    it.each([false, true])(
      "自动完成=%s：只在可操作且未勾选的验证控件出现时退出",
      async (automatic) => {
        let documents = 0,
          clicked = false;
        let diagnostic: AvwikiBrowserDiagnostics | undefined;
        await withSafeCatalogBrowser(
          (request) => {
            if (request.href === url) {
              const challenge = ++documents === 1;
              return {
                status: challenge ? 403 : 200,
                headers: challenge ? { "cf-mitigated": "challenge" } : undefined,
                body: challenge
                  ? `<main>Safe verification fixture</main><iframe src="https://challenges.cloudflare.com${challengePath}"></iframe><script>
                    addEventListener('message',e=>{if(e.origin==='https://challenges.cloudflare.com'&&e.data==='safe-ready')setTimeout(()=>location.reload(),3200)});
                  </script>`
                  : "<main>Safe automatic result</main>",
              };
            }
            if (request.pathname === challengePath)
              return {
                body: `<div id="safe-host"></div><script>
                  const root=document.querySelector('#safe-host').attachShadow({mode:'closed'});
                  root.innerHTML='<style>input{opacity:0;width:24px;height:24px}label{display:block;width:140px;height:32px}.hidden{display:none}</style>'+
                    ${JSON.stringify(
                      automatic
                        ? '<label><input type="checkbox" disabled>Safe disabled</label><label class="hidden"><input type="checkbox">Safe hidden</label><label><input type="checkbox" checked>Safe completed</label>'
                        : '<label><input type="checkbox">Safe manual verification</label>',
                    )};
                  root.addEventListener('click',()=>fetch('/safe-clicked'));
                  ${automatic ? "parent.postMessage('safe-ready','https://avwikidb.com')" : ""};
                </script>`,
              };
            if (request.pathname === "/safe-clicked") clicked = true;
            return { status: 404, body: "" };
          },
          async (browser, signal) => {
            const result = readAvwikiBrowserPage(
              browser,
              url,
              signal,
              undefined,
              undefined,
              (value) => {
                diagnostic = value;
              },
            );
            if (automatic) await expect(result).resolves.toBe("<main>Safe automatic result</main>");
            else await expect(result).rejects.toMatchObject({ reason: "interaction_required" });
          },
        );
        expect(clicked).toBe(false);
        expect(diagnostic?.challengeInteraction).toBe(automatic ? undefined : "required");
        expect(JSON.stringify(diagnostic)).not.toMatch(/safe-interaction|https:|Safe manual/);
      },
      25000,
    );
  },
);
