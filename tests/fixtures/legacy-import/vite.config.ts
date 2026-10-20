import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "../../helpers/mediaHost";

const project = fileURLToPath(new URL("../../../", import.meta.url));
// 仅生成和使用 .tmp 下的合成数据库，不允许指定真实 AppData 路径。
await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
const root = await fs.mkdtemp(path.join(project, ".tmp/legacy-ui-"));
await fs.mkdir(path.join(root, "com.ddmoyu.javm"));
const source = new DatabaseSync(path.join(root, "com.ddmoyu.javm/javm.db"));
source.exec(await fs.readFile(path.join(project, "tests/fixtures/legacy-v2.sql"), "utf8"));
source.exec(
  "INSERT INTO directories(id,path) VALUES('sample-directory','C:/synthetic'); INSERT INTO videos(id,title,video_path,dir_path) VALUES('sample-video','合成影片','C:/synthetic/example.mp4','C:/synthetic');",
);
source.close();
const host = new MediaHost();
await host.start(path.join(root, "JAVM/downloads-v1.sqlite3"));
await host.request("library.status");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "legacy-import-fixture",
      configureServer(server) {
        server.httpServer?.once("close", () => void host.close());
        server.middlewares.use("/__legacy-test", (request, response) => {
          void (async () => {
            try {
              let body = "";
              for await (const part of request) {
                body += String(part);
                if (body.length > 1000) throw new Error("请求过大");
              }
              const { method } = JSON.parse(body) as { method: string };
              if (
                ![
                  "library.legacy.check",
                  "library.legacy.status",
                  "library.legacy.start",
                  "library.legacy.cancel",
                ].includes(method)
              )
                throw new Error("不支持的验证操作");
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ result: await host.request(method) }));
            } catch (error) {
              response.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          })();
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5198, strictPort: true, fs: { allow: [project] } },
});
