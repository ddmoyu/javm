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
        },
        load(id) {
          if (id === "\0safe:empty-catalog") return "export default {entries:[]}";
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
    it("正式 Worker 可分批接收 7,804 条 SQLite 演员记录并返回目录", async () => {
      const code = await safeWorker();
      const fixture = `
        self.fetch = async () => { throw new Error('Fixture must not make network requests'); };
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
                let cursor=0, sequence=0, loading=false;
                const next=()=>{
                  if(cursor===7804) {loading=true;worker.postMessage({id:++sequence,operation:'discoveryLoad',payload:{cache:null}});return;}
                  const reset=cursor===0, count=Math.min(500,7804-cursor);
                  const entries=Array.from({length:count},(_,offset)=>({dimension:'actresses',lane:'censored',id:'safe-'+(cursor+offset),
                    name:'安全演员'+(cursor+offset),label:'安全演员'+(cursor+offset),aliases:[],translationStatus:'pending',category:'',videoCount:10,countUpdatedAt:1}));
                  cursor+=count;
                  worker.postMessage({id:++sequence,operation:'javbusSeedAppend',payload:{entries,reset,done:cursor===7804}});
                };
                worker.onmessage=({data})=>data.error ? finish({error:data.error}) : loading ? finish({count:data.value.catalogs.actresses.names.length}) : next();
                next();
              })`,
              awaitPromise: true,
              returnByValue: true,
            },
            String(attached.sessionId),
          );
          return (response.result as { value: unknown }).value;
        },
      );
      expect(result).toEqual({ count: 7804 });
    }, 30000);
  },
);
