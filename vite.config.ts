import { defineConfig } from "vite-plus";
import frontend from "./frontend/vite.config";

export default defineConfig({
  ...frontend,
  lint: {
    plugins: ["typescript", "react", "jsx-a11y"],
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [
      "build/**",
      "dist/**",
      "bin/**",
      ".neutralino/**",
      ".tmp/**",
      "tests/fixtures/posix-desktop/media/**",
      "tests/fixtures/posix-desktop/.build/**",
    ],
  },
  fmt: {
    ignorePatterns: [
      "native/**/*.inc",
      "frontend/src/services/catalog/builtin-*.json",
      "docs/REFACTOR_PLAN.md",
      "pnpm-lock.yaml",
      "resources/licenses/**",
      "tests/fixtures/posix-desktop/media/**",
      "tests/fixtures/posix-desktop/.build/**",
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
