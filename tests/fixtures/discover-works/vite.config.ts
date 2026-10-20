import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { MediaHost } from "../../helpers/mediaHost";

const project = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: path.join(project, "resources"),
  server: { host: "127.0.0.1", port: 5194, strictPort: true, fs: { allow: [project] } },
  plugins: [
    react(),
    {
      name: "safe-discover-works-fixture",
      async configureServer(server) {
        await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
        const root = await fs.mkdtemp(path.join(project, ".tmp/discover-works-ui-"));
        const host = new MediaHost();
        await host.start(path.join(root, "downloads.sqlite3"));
        server.httpServer?.once("close", () => {
          void host.close();
        });
        const allowed = new Set([
          "library.status",
          "library.summary",
          "library.query",
          "library.facets",
          "library.video",
          "library.catalogAppend",
          "library.scrape.prepare",
          "library.scrape.commit",
        ]);
        server.middlewares.use("/__library-test", (request, response) => {
          void (async () => {
            try {
              let body = "";
              for await (const part of request) {
                body += String(part);
                if (body.length > 65536) throw new Error("请求过大");
              }
              const { method, params } = JSON.parse(body) as { method: string; params: unknown };
              if (!allowed.has(method)) throw new Error("安全样例不支持此操作");
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ result: await host.request(method, params) }));
            } catch (error) {
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({ error: error instanceof Error ? error.message : "样例请求失败" }),
              );
            }
          })();
        });
      },
    },
  ],
});
