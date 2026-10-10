import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("../../../dist/prototype-mantine", import.meta.url)),
    emptyOutDir: true,
  },
});
