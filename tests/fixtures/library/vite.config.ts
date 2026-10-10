import type { ViteDevServer, PreviewServer } from "vite-plus";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MediaHost } from "../../helpers/mediaHost";

const project = fileURLToPath(new URL("../../../", import.meta.url));
// 必须使用集成测试生成的独立目录，禁止接入应用数据目录或真实旧库。
const fixture = path.resolve(process.env.JAVM_LIBRARY_FIXTURE ?? "");
const relative = path.relative(path.join(project, ".tmp"), fixture);
if (!/^library-query-[^\\/]+$/.test(relative))
  throw new Error("请指定 .tmp/library-query-* 合成片库目录");

async function connect(server: ViteDevServer | PreviewServer) {
  const host = new MediaHost();
  await host.start(path.join(fixture, "downloads-v1.sqlite3"));
  server.httpServer?.once("close", () => {
    void host.close();
  });
  const allowed = new Set([
    "library.status",
    "library.query",
    "library.summary",
    "library.facets",
    "library.video",
    "library.favorite",
    "library.duplicateCode",
  ]);
  // 测试用 Vite 中间件连接真实 C++ Extension；不会进入正式构建。
  server.middlewares.use("/__library-test", (request, response) => {
    void (async () => {
      try {
        let body = "";
        for await (const part of request) {
          body += String(part);
          if (body.length > 65536) throw new Error("测试请求过大");
        }
        const { method, params } = JSON.parse(body) as { method: string; params: unknown };
        if (!allowed.has(method)) throw new Error("测试夹具不支持此操作");
        const result = await host.request(method, params);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
    })();
  });
}
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: path.join(project, "resources"),
  server: { host: "127.0.0.1", port: 5176, strictPort: true, fs: { allow: [project] } },
  preview: { host: "127.0.0.1", port: 5177, strictPort: true },
  build: { outDir: path.join(project, ".tmp/library-preview"), emptyOutDir: true },
  plugins: [
    react(),
    {
      name: "synthetic-library-extension",
      configureServer: connect,
      configurePreviewServer: connect,
    },
  ],
});
