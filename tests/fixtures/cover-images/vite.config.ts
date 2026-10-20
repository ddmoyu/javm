import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  server: {
    hmr: false,
    host: "127.0.0.1",
    port: 5197,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] },
  },
  plugins: [react()],
});
