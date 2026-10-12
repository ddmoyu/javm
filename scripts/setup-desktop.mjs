import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// neu update recursively clears cwd/.tmp. Keep verified dependencies and fixtures
// outside its working directory, just as the desktop bundler does.
const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "build");
await mkdir(build, { recursive: true });
const stage = await mkdtemp(path.join(build, "desktop-setup-"));
const require = createRequire(import.meta.url);
try {
  await cp(path.join(root, "neutralino.config.json"), path.join(stage, "neutralino.config.json"));
  const result = spawnSync(
    process.execPath,
    [require.resolve("@neutralinojs/neu/bin/neu.js"), "update"],
    {
      cwd: stage,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Neutralino setup failed: ${result.status}`);
  await access(path.join(stage, "bin/neutralino-win_x64.exe"));
  await cp(path.join(stage, "bin"), path.join(root, "bin"), { recursive: true });
} finally {
  if (path.dirname(stage) !== build || !path.basename(stage).startsWith("desktop-setup-"))
    throw new Error("Refusing cleanup outside the owned setup directory");
  await rm(stage, { recursive: true, force: true });
}
