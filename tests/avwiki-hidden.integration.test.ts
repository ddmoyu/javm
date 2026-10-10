import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CdpConnection } from "../frontend/src/services/streamResolution/cdp";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import { parseAvwikiWorks } from "../frontend/src/services/catalog/avwikiWorks";
import { hiddenWebviewConfig } from "../frontend/src/platform/neutralino/hiddenWebview";
import { quoteWindowsArgument } from "../frontend/src/platform/neutralino/process";
import { listing } from "./fixtures/discover-works/data";

describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "隐藏浏览器作品读取（隔离安全文档）",
  () => {
    it.each(["普通作品页", "403 自动检查后重载", "离线包宿主 403 自动检查后重载"])(
      "%s：读取合成结果后关闭受管实例",
      async (scenario) => {
        const project = path.resolve(import.meta.dirname, "..");
        const packaged = scenario.startsWith("离线包宿主");
        const challengeScenario = scenario.includes("403");
        const executable = packaged
          ? path.join(
              (
                JSON.parse(
                  await readFile(path.join(project, "dist/offline/latest.json"), "utf8"),
                ) as { directory: string }
              ).directory,
              "javm-win_x64.exe",
            )
          : path.join(project, "bin/neutralino-win_x64.exe");
        const root = await mkdtemp(path.join(project, ".tmp/avwiki-hidden-safe-"));
        const config = hiddenWebviewConfig("http://127.0.0.1:1", "");
        // 虚构文档在请求阶段由 CDP 响应；禁止 DNS 解析，不能落到真实来源。
        config.modes.window.webviewArgs +=
          ' --host-resolver-rules="MAP * ~NOTFOUND" --disable-background-networking';
        await writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
        await writeFile(
          path.join(root, "launch.ps1"),
          await readFile(path.join(project, "frontend/src/platform/neutralino/hiddenProcess.ps1")),
        );
        await writeFile(
          path.join(root, "launch.json"),
          JSON.stringify({
            file: executable,
            arguments: ["--res-mode=directory", `--path=${root}`]
              .map(quoteWindowsArgument)
              .join(" "),
            profile: path.join(root, "profile"),
            ownerPid: process.pid,
            timeoutMs: 20000,
          }),
        );
        const launcher = spawn(
          path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(root, "launch.ps1"),
            "-Config",
            path.join(root, "launch.json"),
          ],
          { windowsHide: true, stdio: "ignore" },
        );
        let exited = false;
        const exit = new Promise<void>((resolve) =>
          launcher.once("exit", () => {
            exited = true;
            resolve();
          }),
        );
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(new Error("安全浏览器验证超时")), 18000);
        let cdp: CdpConnection | undefined;
        const requested: string[] = [];
        const statuses: number[] = [];
        let documents = 0;
        try {
          while (!cdp) {
            abort.signal.throwIfAborted();
            if (exited) throw new Error("安全隐藏实例提前结束");
            for (const relative of [
              "profile/EBWebView/DevToolsActivePort",
              "profile/DevToolsActivePort",
            ]) {
              const active = await readFile(path.join(root, relative), "utf8").catch(() => "");
              if (!active) continue;
              const [port, endpoint] = active.trim().split(/\r?\n/);
              cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${endpoint}`, abort.signal);
              break;
            }
            if (!cdp) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const connection = cdp;
          const html = await readAvwikiBrowserPage(
            {
              on: (listener) => connection.on(listener),
              send: async (method, params, sessionId) => {
                if (method === "Page.navigate") requested.push(String(params?.url));
                if (method === "Fetch.continueRequest") {
                  const stage = ++documents;
                  const challenge = challengeScenario && stage === 1;
                  const redirect = challengeScenario && stage === 2;
                  const responseCode = challenge ? 403 : redirect ? 302 : 200;
                  const body = challenge
                    ? `<!doctype html><html><body><main>安全自动检查示例</main><script>setTimeout(()=>{history.replaceState(null,'','?__cf_chl_rt_tk=safe-mock');location.replace('/actor/1?__cf_chl_tk=safe-mock')},150)</script></body></html>`
                    : `<!doctype html><html><body>${listing()}</body></html>`;
                  return connection.send(
                    "Fetch.fulfillRequest",
                    {
                      requestId: params?.requestId,
                      responseCode,
                      responseHeaders: [
                        { name: "Content-Type", value: "text/html; charset=utf-8" },
                        {
                          name: "Content-Security-Policy",
                          value: `default-src 'none'; img-src 'none'; media-src 'none'; script-src ${challenge ? "'unsafe-inline'" : "'none'"}`,
                        },
                        ...(challenge ? [{ name: "cf-mitigated", value: "challenge" }] : []),
                        ...(redirect
                          ? [{ name: "Location", value: "/actor/1/?__cf_chl_tk=safe-mock" }]
                          : []),
                      ],
                      body: Buffer.from(body).toString("base64"),
                    },
                    sessionId,
                  );
                }
                return connection.send(method, params, sessionId);
              },
            },
            "https://avwikidb.com/actor/1/",
            abort.signal,
            (response) => statuses.push(response.status),
          );
          const result = parseAvwikiWorks(
            html,
            { id: "1", name: "示例女演员甲", url: "https://avwikidb.com/actor/1/" },
            1,
          );
          expect(result.items.map((item) => item.code)).toEqual(["TEST-001", "TEST-002"]);
          expect(requested).toEqual(["https://avwikidb.com/actor/1/"]);
          expect(documents).toBe(challengeScenario ? 3 : 1);
          expect(statuses).toEqual(challengeScenario ? [403, 200] : [200]);
        } finally {
          clearTimeout(timer);
          await cdp?.send("Browser.close").catch(() => {});
          cdp?.close();
          abort.abort();
          const stopTimer = setTimeout(() => launcher.kill(), 5000);
          try {
            await exit;
          } finally {
            clearTimeout(stopTimer);
          }
        }
        expect(exited).toBe(true);
      },
      30000,
    );
  },
);
