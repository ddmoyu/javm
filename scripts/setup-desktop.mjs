import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { desktopHostFile, installDesktopHost } from "./desktop-host.mjs";

// neu update removes cwd/.tmp. Only expose a fresh, owned staging directory.
const host = desktopHostFile();
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.includes("--verified-posix-host")) {
  if (process.platform === "win32") throw new Error("Windows 继续使用官方发布宿主");
  const { json, specification, target, verifyInventory } =
    await import("./third-party/posix/common.mjs");
  const component = (await json(path.join(root, `build/dependencies/${target}/resolved.json`)))
    .components.neutralino;
  const spec = await specification("neutralino");
  if (!component?.releaseId || component.fingerprint !== spec.fingerprint)
    throw new Error("宿主组件缺失或与当前配方不符");
  await verifyInventory(component.path, await json(path.join(component.path, "manifest.json")));
  await mkdir(path.join(root, "bin"), { recursive: true });
  await copyFile(path.join(component.path, "runtime/neutralino"), path.join(root, "bin", host));
  await chmod(path.join(root, "bin", host), 0o755);
  console.log(`已安装经过回读校验的 Neutralino 源码构建：${component.tag}`);
  process.exit(0);
}
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
