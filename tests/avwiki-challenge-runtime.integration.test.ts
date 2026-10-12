import { describe, expect, it } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import type { AvwikiBrowserDiagnostics } from "../frontend/src/services/catalog/avwikiBrowser";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

// 此地址只满足正式校验器；DNS 被禁用，响应由 CDP 提供，绝不访问真实站点。
const url = "https://avwikidb.com/actor/1/";
const document = (script: string) =>
  `<!doctype html><html><body><main>Safe automatic check</main><script>${script}</script></body></html>`;

describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "403 验证运行环境（真实隐藏宿主、安全合成数据）",
  () => {
    it.each([
      ["动画帧", "requestAnimationFrame(()=>location.reload())"],
      [
        "脚本 URL 的图片查询参数",
        "const s=document.createElement('script');s.src='/safe-check.js?hint=placeholder.png';document.body.append(s)",
      ],
      [
        "跨域 iframe 与 Worker",
        `const f=document.createElement('iframe');f.src='https://challenges.cloudflare.com/safe-frame';document.body.append(f);addEventListener('message',e=>{if(e.origin==='https://challenges.cloudflare.com'&&e.data==='safe-ready')location.reload()})`,
      ],
      [
        "共享 Worker",
        `const worker=new SharedWorker(URL.createObjectURL(new Blob(["onconnect=e=>e.ports[0].postMessage('safe-ready')"],{type:'application/javascript'})));worker.port.onmessage=()=>location.reload();worker.port.start()`,
      ],
      [
        "媒体拦截仍有效",
        `Promise.all([
      fetch('/blocked.png?cache=safe').then(()=>{throw new Error('Image escaped')},()=>{}),
      fetch('/blocked.m3u8?cache=safe').then(()=>{throw new Error('Playlist escaped')},()=>{}),
      new Promise(resolve=>{const video=document.createElement('video');video.onloadeddata=()=>{throw new Error('Media escaped')};video.onerror=resolve;video.src='/blocked-media';video.load()})
    ]).then(()=>location.reload())`,
      ],
    ])(
      "%s：自动检查完成后读取正常页面",
      async (_name, script) => {
        let documents = 0;
        const statuses: number[] = [];
        const types: string[] = [];
        const commands: string[] = [];
        const failures: string[] = [];
        const result = await withSafeCatalogBrowser(
          (request) => {
            if (request.origin === new URL(url).origin && request.pathname === "/actor/1/") {
              const challenge = ++documents === 1;
              return {
                status: challenge ? 403 : 200,
                headers: challenge ? { "cf-mitigated": "challenge" } : undefined,
                body: challenge ? document(script) : "<main>Safe result ready</main>",
              };
            }
            if (request.pathname === "/safe-check.js")
              return { type: "application/javascript", body: "location.reload()" };
            if (request.pathname === "/safe-frame")
              return {
                body: document(`
        const worker=new Worker('/safe-worker.js');
        worker.onmessage=()=>{parent.postMessage('safe-ready','https://avwikidb.com')};
      `),
              };
            if (request.pathname === "/safe-worker.js")
              return { type: "application/javascript", body: "postMessage('safe-worker-ready')" };
            if (request.pathname === "/favicon.ico") return { status: 404, body: "" };
          },
          async (browser, signal) => {
            browser.on((event) => {
              if (event.method === "Target.attachedToTarget")
                types.push(String((event.params.targetInfo as { type: string }).type));
              if (event.method === "Network.loadingFailed")
                failures.push(String(event.params.errorText));
              if (event.method === "Runtime.exceptionThrown") failures.push("SCRIPT_EXCEPTION");
            });
            try {
              return await readAvwikiBrowserPage(
                {
                  on: browser.on,
                  send: async (method, params, session) => {
                    try {
                      return await browser.send(method, params, session);
                    } catch (error) {
                      commands.push(method);
                      throw error;
                    }
                  },
                },
                url,
                signal,
                (response) => statuses.push(response.status),
              );
            } catch (error) {
              throw new Error(JSON.stringify({ documents, statuses, types, commands, failures }), {
                cause: error,
              });
            }
          },
        );
        expect(result).toBe("<main>Safe result ready</main>");
        expect(statuses).toEqual([403, 200]);
        expect(documents).toBe(2);
      },
      25000,
    );

    it.each(["人工验证", "持续验证"])(
      "%s：结束读取并回收隐藏实例",
      async (scenario) => {
        let requests = 0;
        let diagnostic: AvwikiBrowserDiagnostics | undefined;
        await expect(
          withSafeCatalogBrowser(
            (request) => {
              if (request.pathname === "/favicon.ico") return { status: 404, body: "" };
              if (request.href !== url) return;
              requests++;
              return {
                status: 403,
                headers: { "cf-mitigated": "challenge" },
                body:
                  scenario === "人工验证"
                    ? "<form id='challenge-form'><input type='checkbox'></form>"
                    : document("throw new Error('Safe error must not reach logs')"),
              };
            },
            async (browser, signal) => {
              const deadline = new AbortController();
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await readAvwikiBrowserPage(
                  browser,
                  url,
                  AbortSignal.any([signal, deadline.signal]),
                  () => {
                    timer ??= setTimeout(
                      () => deadline.abort(new Error("Safe verification deadline")),
                      600,
                    );
                  },
                  undefined,
                  (value) => {
                    diagnostic = value;
                  },
                );
              } finally {
                clearTimeout(timer);
              }
            },
          ),
        ).rejects.toThrow(scenario === "人工验证" ? "需要人工验证" : "Safe verification deadline");
        expect(requests).toBe(1);
        expect(diagnostic?.activePages).toBe(1);
        if (scenario === "持续验证") expect(diagnostic?.scriptErrors).toBe(1);
        expect(JSON.stringify(diagnostic)).not.toContain("Safe error");
      },
      25000,
    );
  },
);
