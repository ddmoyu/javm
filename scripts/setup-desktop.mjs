import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// neu update removes cwd/.tmp. Only expose a fresh, owned staging directory.
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
  await mkdir(path.join(root, "bin"), { recursive: true });
  for (const filename of ["neutralino-win_x64.exe"])
    await copyFile(path.join(stage, "bin", filename), path.join(root, "bin", filename));
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
