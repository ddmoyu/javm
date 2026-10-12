import path from "node:path";
import { build } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";

// 编译正式 Worker，但在模块解析前替换所有真实目录、内置条目和采集清单。
async function safeWorker() {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
    plugins: [
      {
        name: "safe-catalog-seeds",
        enforce: "pre",
        resolveId(source) {
          if (source.endsWith(".csv?url") || source.endsWith(".json?url"))
            return `\0safe:${source}`;
          if (source.includes("builtin-") && source.endsWith(".json"))
            return "\0safe:empty-catalog";
          if (source.endsWith("/manifest.json")) return "\0safe:manifest";
        },
        load(id) {
          if (id === "\0safe:empty-catalog") return "export default {entries:[]}";
          if (id === "\0safe:manifest")
            return 'export const collected_at = "2026-10-10T00:00:00.000Z"';
          if (id.startsWith("\0safe:")) {
            const file = id.slice(id.indexOf("/catalogs/") + 10).replace("?url", "");
            return `export default ${JSON.stringify(`https://safe.example.invalid/${file}`)}`;
          }
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.resolve("frontend/src/services/catalog/catalogWorker.ts"),
        formats: ["iife"],
        name: "SafeCatalogWorker",
      },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!output || !("output" in output)) throw new Error("Unexpected fixture bundle");
  const chunks = output.output.filter((entry) => entry.type === "chunk");
  if (chunks.length !== 1) throw new Error("Expected one fixture Worker");
  return chunks[0]!.code;
}

describe.runIf(process.platform === "win32" && process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "大名单内置快照加载（隐藏 WebView2、安全合成数据）",
  () => {
    it("正式 Worker 可读取 75,303 条演员 CSV 并返回目录", async () => {
      const code = await safeWorker();
      const fixture = `
        const header = 'source,kind,lane,source_id,name_original,name_zh,aliases,translation_status,source_url,category,video_count,count_updated_at\\r\\n';
        const rows = Array.from({length:75303}, (_, index) =>
          'javbus,star,censored,safe-' + index + ',安全演员' + index + ',,,pending,https://www.javbus.com/star/safe-' + index + ',,,\\r\\n');
        const actors = header + rows.join('');
        self.fetch = async input => {
          const url = new URL(input);
          if (url.hostname !== 'safe.example.invalid') throw new Error('Unexpected fixture request');
          if (url.pathname.startsWith('/javbus/')) return new Response(url.pathname.endsWith('/actresses.csv') ? actors : header);
          const kinds = {'actresses.csv':'actor','male-actors.csv':'histrion','directors.csv':'director','makers.csv':'maker','series.csv':'series'};
          const kind = kinds[url.pathname.split('/').pop()];
          if (!kind) throw new Error('Unknown fixture CSV');
          return new Response('source,kind,source_id,name_original,name_zh,aliases,translation_status,source_url\\r\\navwikidb,' + kind + ',1,安全演员0,,,pending,https://avwikidb.com/' + kind + '/1/\\r\\n');
        };
      `;
      const result = await withSafeCatalogBrowser(
        () => {
          throw new Error("Fixture must not make network requests");
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
          const response = await browser.send(
            "Runtime.evaluate",
            {
              expression: `new Promise(resolve => {
                const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(fixture + code)}], {type:'application/javascript'}));
                const worker = new Worker(workerUrl);
                const finish = result => {clearTimeout(timer);worker.terminate();URL.revokeObjectURL(workerUrl);resolve(result)};
                const timer = setTimeout(() => finish({error:'Worker timed out'}), 10000);
                worker.onerror = () => finish({error:'Worker startup failed'});
                worker.onmessage = ({data}) => finish(data.error ? {error:data.error} : {count:data.value.catalogs.actresses.names.length});
                worker.postMessage({id:1,operation:'discoveryLoad',payload:{cache:null}});
              })`,
              awaitPromise: true,
              returnByValue: true,
            },
            String(attached.sessionId),
          );
          return (response.result as { value: unknown }).value;
        },
      );
      expect(result).toEqual({ count: 75303 });
    }, 30000);
  },
);
