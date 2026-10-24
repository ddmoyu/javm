import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath } from "vite-plus";

// Worker 必须取自播放器适配器依赖的同一份 hls.js，避免另行锁定或提升传递依赖。
const playerRequire = createRequire(import.meta.resolve("@videojs/hlsjs-video"));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../resources", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^#hls-worker\?url$/,
        replacement: `${normalizePath(playerRequire.resolve("hls.js/dist/hls.worker.js"))}?url`,
      },
    ],
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    target: ["safari16", "chrome105"],
    cssTarget: ["safari16", "chrome105"],
    outDir: fileURLToPath(new URL("../dist/frontend", import.meta.url)),
    emptyOutDir: true,
  },
});
