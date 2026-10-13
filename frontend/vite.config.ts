import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../resources", import.meta.url)),
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    target: ["safari16", "chrome105"],
    cssTarget: ["safari16", "chrome105"],
    outDir: fileURLToPath(new URL("../dist/frontend", import.meta.url)),
    emptyOutDir: true,
  },
});
