import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { desktopHostFile, installDesktopHost } from "./desktop-host.mjs";

// neu update removes cwd/.tmp. Only expose a fresh, owned staging directory.
const host = desktopHostFile();
const root = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = path.join(root, "build");
await mkdir(buildRoot, { recursive: true });
const stage = await mkdtemp(path.join(buildRoot, "desktop-setup-"));
const require = createRequire(import.meta.url);
try {
  const config = JSON.parse(await readFile(path.join(root, "neutralino.config.json"), "utf8"));
  delete config.cli.frontendLibrary;
  await writeFile(path.join(stage, "neutralino.config.json"), JSON.stringify(config, null, 2));
  const result = spawnSync(
    process.execPath,
    [require.resolve("@neutralinojs/neu/bin/neu.js"), "update"],
    {
      cwd: stage,
      windowsHide: true,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Neutralino host setup failed: " + result.status);
  await installDesktopHost(path.join(stage, "bin"), path.join(root, "bin"));
  console.log(`Neutralino 桌面宿主已准备：${host}`);
} finally {
  const resolved = path.resolve(stage);
  if (
    path.dirname(resolved) === path.resolve(buildRoot) &&
    path.basename(resolved).startsWith("desktop-setup-")
  ) {
    await rm(resolved, { recursive: true, force: true });
  } else {
    console.error("Refusing cleanup outside the owned setup staging directory");
    process.exitCode = 1;
  }
}
