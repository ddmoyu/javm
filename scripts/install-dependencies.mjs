import { mkdir, readFile, cp, mkdtemp, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { hashFile, safeChild, verifyBundle } from "./dependency-bundle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "scripts/dependency-bundle.json"), "utf8"));
if (
  lock.repository !== "ddmoyu/javm-dependencies" ||
  !/^deps-windows-x64-[a-z0-9-]+$/.test(lock.tag) ||
  !/^[a-f0-9]{64}$/.test(lock.sha256) ||
  !/^JAVM-dependencies-[a-z0-9-]+-windows-x64\.zip$/.test(lock.asset)
)
  throw new Error("Invalid dependency lock");
const cache = path.join(root, ".tmp/dependency-bundles");
await mkdir(cache, { recursive: true });
const archive = path.join(cache, lock.asset);
execFileSync(
  path.join(process.env.SystemRoot, "System32/curl.exe"),
  [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--silent",
    "--show-error",
    "--output",
    archive,
    `https://github.com/${lock.repository}/releases/download/${lock.tag}/${lock.asset}`,
  ],
  { stdio: "inherit", windowsHide: true },
);
if ((await hashFile(archive)) !== lock.sha256)
  throw new Error("Dependency archive SHA-256 mismatch");
const directory = await mkdtemp(path.join(cache, "verified-"));
const tar = path.join(process.env.SystemRoot, "System32/tar.exe");
const entries = execFileSync(tar, ["-tf", archive], { encoding: "utf8", windowsHide: true });
for (const name of entries.trim().split(/\r?\n/)) safeChild(directory, name.replace(/\/$/, ""));
execFileSync(tar, ["-xf", archive, "-C", directory], { windowsHide: true, stdio: "inherit" });
const bundleDirectory = safeChild(directory, path.basename(lock.asset, ".zip"));
const manifest = await verifyBundle(bundleDirectory, root);
if (manifest.releaseTag !== lock.tag) throw new Error("Dependency release tag mismatch");
await cp(path.join(bundleDirectory, "bin"), path.join(root, "bin"), { recursive: true });
await mkdir(path.join(root, "build"), { recursive: true });
await writeFile(path.join(root, "build/dependency-path.txt"), bundleDirectory);
if (process.env.GITHUB_ENV)
  await appendFile(process.env.GITHUB_ENV, `JAVM_PREBUILT_DEPENDENCIES=${bundleDirectory}\n`);
console.log(`Verified dependency release: ${lock.tag}\nPrebuilt directory: ${bundleDirectory}`);
