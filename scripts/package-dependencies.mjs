import { cp, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { recipeFiles, recipeHash, hashFile, inventory, verifyBundle } from "./dependency-bundle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dependencies = JSON.parse(await readFile(path.join(root, "scripts/offline-dependencies.json"), "utf8"));
const recipeSha256 = await recipeHash(root);
const buildId = `${recipeSha256.slice(0, 12)}-${process.env.GITHUB_RUN_ID || Date.now()}`;
const releaseTag = `deps-windows-x64-${buildId}`;
const name = `JAVM-dependencies-${buildId}-windows-x64`;
const output = path.join(root, "dist/dependencies", name);
await mkdir(output, { recursive: true });
async function copy(source, target) {
  await mkdir(path.dirname(path.join(output, target)), { recursive: true });
  await cp(path.join(root, source), path.join(output, target), { recursive: true });
}
await copy("bin/tools", "bin/tools");
await copy("bin/licenses", "bin/licenses");
for (const file of ["MediaInfo.dll", "mediainfo-lite.json"])
  await copy(`build/dependencies/bin/${file}`, `bin/${file}`);
const source = "build/dependencies/_deps/mediainfo_source-src";
await copy(`${source}/MediaInfoLib/Source/MediaInfoDLL`, "sdk/mediainfo/MediaInfoLib/Source/MediaInfoDLL");
for (const [relative, license] of [
  ["MediaInfoLib/License.html", "MediaInfo.html"],
  ["ZenLib/License.txt", "ZenLib.txt"],
  ["zlib/LICENSE", "zlib.txt"],
]) {
  await copy(`${source}/${relative}`, `sdk/mediainfo/${relative}`);
  await copy(`${source}/${relative}`, `bin/licenses/${license}`);
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  schema: 1, platform: "windows-x64", releaseTag, sourceCommit, recipeSha256,
  runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  dependencies, files: await inventory(output),
}, null, 2));
await verifyBundle(output, root);
const sources = path.join(root, "build/dependency-sources", name);
await mkdir(sources, { recursive: true });
for (const file of recipeFiles) {
  await mkdir(path.dirname(path.join(sources, file)), { recursive: true });
  await cp(path.join(root, file), path.join(sources, file));
}
await cp(path.join(output, "bin/licenses"), path.join(sources, "licenses"), { recursive: true });
for (const key of ["ffmpeg", "curl", "mediainfo"]) {
  const dep = dependencies[key];
  const archive = path.join(sources, dep.file);
  execFileSync(path.join(process.env.SystemRoot, "System32/curl.exe"),
    ["--fail", "--location", "--retry", "3", "--silent", "--show-error", "--output", archive, dep.url],
    { windowsHide: true, stdio: "inherit" });
  if (await hashFile(archive) !== dep.sha256) throw new Error(`Source checksum mismatch: ${key}`);
}
await writeFile(path.join(sources, "README.txt"), `JAVM dependency sources\nSource commit: ${sourceCommit}\nRecipe SHA-256: ${recipeSha256}\nBuild on Windows x64 with MSVC, Git Bash and NASM: powershell -File scripts/build-dependencies.ps1\nFFmpeg and curl use unmodified upstream sources. Source archives and licenses are included.\n`);
function zip(directory, archive) {
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(root, "scripts/archive-offline.ps1"), "-Source", directory, "-Destination", archive],
    { windowsHide: true, stdio: "inherit" });
}
const archive = `${output}.zip`;
const sourceArchive = `${output}-sources.zip`;
zip(output, archive);
zip(sources, sourceArchive);
const sha256 = await hashFile(archive);
await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
await writeFile(`${sourceArchive}.sha256`, `${await hashFile(sourceArchive)}  ${path.basename(sourceArchive)}\n`);
await writeFile(path.join(root, "dist/dependencies/latest.json"), JSON.stringify({ releaseTag, archive, sourceArchive, sha256, recipeSha256, sourceCommit }, null, 2));
await writeFile(path.join(root, "dist/dependencies/release-notes.md"), `JAVM Windows x64 精简依赖\n\n- 来源提交：ddmoyu/javm@${sourceCommit}\n- 构建配方：${recipeSha256}\n- 包含精简 FFmpeg、MediaInfo、curl 及固定版本运行工具。\n- sources.zip 提供对应源码、裁剪配置与许可材料。\n- 应用通过精确资产名和 SHA-256 复用本构建，不使用 latest。\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${releaseTag}\narchive=${archive}\nsources=${sourceArchive}\n`);
console.log(JSON.stringify({ releaseTag, archive, sha256 }, null, 2));
