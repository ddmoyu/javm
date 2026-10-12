import { defineConfig } from "vite-plus";
import frontend from "./frontend/vite.config";

export default defineConfig({
  ...frontend,
  lint: {
    plugins: ["typescript", "react", "jsx-a11y"],
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["build/**", "dist/**", "bin/**", ".neutralino/**", ".tmp/**"],
  },
  fmt: {
    ignorePatterns: [
      "native/**/*.inc",
      "frontend/src/services/catalog/builtin-*.json",
      "docs/REFACTOR_PLAN.md",
      "pnpm-lock.yaml",
      "resources/licenses/**",
      "build/**",
      "dist/**",
      "bin/**",
      ".neutralino/**",
      ".tmp/**",
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "../tests/**/*.test.ts"],
  },
});
