import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// neu uses and removes cwd/.tmp. Never expose the workspace's fixtures, local
// databases or dependency downloads to that packaging scratch directory.
if (process.platform !== "win32") throw new Error("Desktop packaging currently supports Windows.");
const root = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = path.resolve(root, "build");
await mkdir(buildRoot, { recursive: true });
const stage = await mkdtemp(path.join(buildRoot, "desktop-package-"));
const require = createRequire(import.meta.url);
const config = JSON.parse(await readFile(path.join(root, "neutralino.config.json"), "utf8"));
config.cli.distributionPath = "/dist/desktop";
// Vite's public directory also holds distribution-only documents. The native
// icon is embedded separately by neu; its public-root copy is unused by the UI.
const distributionOnly = String.raw`(?:^|[/\\])dist[/\\]frontend[/\\](?:licenses(?:[/\\]|$)|offline(?:[/\\]|$)|\.gitkeep$|icon\.png$)`;
config.cli.resourcesExclude = config.cli.resourcesExclude
  ? `(?:${config.cli.resourcesExclude})|${distributionOnly}`
  : distributionOnly;
delete config.cli.frontendLibrary;
const copy = async (relative) => {
  const source = path.resolve(root, relative);
  const target = path.resolve(stage, relative);
  if (!source.startsWith(path.resolve(root) + path.sep) || !target.startsWith(stage + path.sep)) {
    throw new Error(`Package input must stay inside the project: ${relative}`);
  }
  await cp(source, target, { recursive: true });
};
try {
  await copy("dist/frontend");
  await copy("bin/neutralino-win_x64.exe");
  const versionStamp = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts/stamp-host-version.ps1"),
      "-HostFile",
      path.join(stage, "bin/neutralino-win_x64.exe"),
      "-VersionSource",
      path.join(root, "build/native/windows-release/bin/JAVM.exe"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (versionStamp.error) throw versionStamp.error;
  if (versionStamp.status !== 0) throw new Error("Host version stamping failed");
  for (const item of config.cli.copyItems || []) await copy(item);
  await writeFile(path.join(stage, "neutralino.config.json"), JSON.stringify(config, null, 2));
  const cli = require.resolve("@neutralinojs/neu/bin/neu.js");
  const bundled = spawnSync(process.execPath, [cli, "build", "--release", "--embed-resources"], {
    cwd: stage,
    stdio: "inherit",
    windowsHide: true,
  });
  if (bundled.error) throw bundled.error;
  if (bundled.status !== 0) throw new Error(`Desktop packaging failed: ${bundled.status}`);
  await cp(path.join(stage, "dist/desktop"), path.join(root, "dist/desktop"), {
    recursive: true,
    force: true,
  });
  // Retire obsolete generated files left by older desktop builds.
  for (const file of ["bin/tools/ffprobe.exe", "bin/licenses/ffmpeg-lite/ffprobe.exe-version.txt"])
    await rm(path.join(root, "dist/desktop/javm", file), { force: true });
  console.log("Windows desktop package: dist/desktop/javm and dist/desktop/javm-release.zip");
} finally {
  const resolved = path.resolve(stage);
  if (
    path.dirname(resolved) === buildRoot &&
    path.basename(resolved).startsWith("desktop-package-")
  ) {
    await rm(resolved, { recursive: true, force: true });
  } else {
    console.error("Refusing cleanup outside the owned package staging directory.");
  }
}
