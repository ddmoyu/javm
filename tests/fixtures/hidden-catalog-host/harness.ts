import { app, filesystem, init } from "@neutralinojs/lib";
import { withHiddenWebview } from "../../../frontend/src/platform/neutralino/hiddenWebview";
import { readAvwikiBrowserPage } from "../../../frontend/src/services/catalog/avwikiBrowser";
import { parseAvwikiWorks } from "../../../frontend/src/services/catalog/avwikiWorks";
import { setLogSink } from "../../../frontend/src/services/logging/events";
import type { LogInput } from "../../../frontend/src/services/logging/events";
import { listing } from "../discover-works/data";

const logs: LogInput[] = [];
const resultPath = `${window.NL_PATH}/result.json`;
const proxyProbe = new URLSearchParams(location.search).get("mode") === "proxy";
const proxy = (window as unknown as { NL_SAFE_PROXY: string }).NL_SAFE_PROXY;
const hostStages: string[] = [];
let proxyStatus = 0;
let stage = "starting";
let saved = Promise.resolve();
function save(extra: Record<string, unknown> = {}) {
  const value = JSON.stringify({ done: false, stage, hostStages, logs, ...extra });
  saved = saved.catch(() => {}).then(() => filesystem.writeFile(resultPath, value));
  return saved;
}
setLogSink((entry) => {
  logs.push(entry);
  void save();
});
init();
async function run() {
  await save();
  const html = await withHiddenWebview(
    new AbortController().signal,
    // 默认使用只返回 502 的本地 mock 代理，不具备转发能力。
    proxy,
    async (connection, signal) => {
      stage = "connected";
      await save();
      if (proxyProbe) {
        const targetUrl = "https://www.gstatic.com/generate_204";
        const targets = (await connection.send("Target.getTargets")).targetInfos as {
          type: string;
          targetId: string;
        }[];
        const { sessionId } = await connection.send("Target.attachToTarget", {
          targetId: targets.find((target) => target.type === "page")!.targetId,
          flatten: true,
        });
        const session = String(sessionId);
        let status = 0;
        let failed = "";
        const unsubscribe = connection.on((event) => {
          if (event.sessionId !== session) return;
          if (event.method === "Fetch.requestPaused") {
            const allowed = (event.params.request as { url: string }).url === targetUrl;
            void connection
              .send(
                allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
                {
                  requestId: event.params.requestId,
                  ...(allowed ? {} : { errorReason: "BlockedByClient" }),
                },
                session,
              )
              .catch(() => {
                failed = "probe command failed";
              });
          }
          if (event.method === "Network.responseReceived") {
            const response = event.params.response as { url: string; status: number };
            if (response.url === targetUrl) status = response.status;
          }
          if (event.method === "Network.loadingFailed") failed = String(event.params.errorText);
        });
        try {
          await connection.send("Network.enable", {}, session);
          await connection.send("Page.enable", {}, session);
          await connection.send(
            "Fetch.enable",
            { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
            session,
          );
          stage = "proxy_request";
          await save();
          void connection.send("Page.navigate", { url: targetUrl }, session).catch(() => {
            failed ||= "probe navigation timeout";
          });
          while (!status) {
            signal.throwIfAborted();
            if (failed) throw new Error(failed);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (status !== 204) throw new Error(`probe status ${status}`);
          proxyStatus = status;
          return "";
        } finally {
          unsubscribe();
        }
      }
      return readAvwikiBrowserPage(
        {
          on: (listener) => connection.on(listener),
          send: async (method, params, sessionId) => {
            if (method === "Fetch.continueRequest") {
              const body = `<!doctype html><html><body>${listing()}</body></html>`;
              return connection.send(
                "Fetch.fulfillRequest",
                {
                  requestId: params?.requestId,
                  responseCode: 200,
                  responseHeaders: [
                    { name: "Content-Type", value: "text/html; charset=utf-8" },
                    { name: "Content-Security-Policy", value: "default-src 'none'" },
                  ],
                  body: btoa(String.fromCharCode(...new TextEncoder().encode(body))),
                },
                sessionId,
              );
            }
            return connection.send(method, params, sessionId);
          },
        },
        "https://avwikidb.com/actor/1/",
        signal,
      );
    },
    (phase) => hostStages.push(phase),
  );
  if (proxyProbe) {
    stage = "completed";
    await save({ done: true, proxyStatus });
    return;
  }
  const page = parseAvwikiWorks(
    html,
    { id: "1", name: "安全示例演员", url: "https://avwikidb.com/actor/1/" },
    1,
  );
  stage = "completed";
  await save({ done: true, codes: page.items.map((item) => item.code) });
}
void run()
  .catch(async (error: unknown) => {
    await save({
      done: true,
      error: error instanceof Error ? error.message : JSON.stringify(error),
    });
  })
  .finally(() => app.exit());
