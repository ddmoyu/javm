import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5206,
    strictPort: true,
    hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] },
  },
});
