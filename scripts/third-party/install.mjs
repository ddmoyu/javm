import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  components,
  root,
  repository,
  specification,
  readJson,
  sha256,
  safePath,
  verifyPayload,
} from "./components.mjs";
import { verifyRuntime } from "./verify.mjs";

const offline = process.argv.includes("--offline");
if (process.argv.slice(2).some((arg) => arg !== "--offline")) throw new Error("未知依赖安装参数");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("当前组件仅支持 Windows x64");
const platform = "windows-x64";
const resolvedPath = path.join(root, "build/dependencies/resolved.json");
const resolved = { schema: 1, platform, components: {} };
const sdk = {};
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
async function copyChecked(source, destination, expected) {
  try {
    if (
      (await stat(destination)).size === expected.bytes &&
      sha256(await readFile(destination)) === expected.sha256
    )
      return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (sha256(await readFile(destination)) !== expected.sha256) throw new Error("安装后哈希不一致");
}
for (const component of components) {
  const spec = await specification(component);
  const cache = path.join(root, ".tmp/component-releases", spec.fingerprint, platform);
  const cachedRelease = path.join(cache, "release.json");
  let record;
  try {
    record = await readJson(cachedRelease);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!record) {
    if (offline) throw new Error(component + " 缺少已验证的组件缓存，请先运行 pnpm offline:setup");
    const release = JSON.parse(gh(["api", "repos/" + repository + "/releases/tags/" + spec.tag]));
    if (release.draft || release.prerelease)
      throw new Error("组件 Release 尚未正式完成：" + spec.tag);
    await mkdir(cache, { recursive: true });
    const download = await mkdtemp(path.join(cache, "download-"));
    gh([
      "release",
      "download",
      spec.tag,
      "--repo",
      repository,
      "--pattern",
      "component-manifest.json",
      "--dir",
      download,
    ]);
    const releaseManifest = await readJson(path.join(download, "component-manifest.json"));
    if (
      releaseManifest.component !== component ||
      releaseManifest.fingerprint !== spec.fingerprint ||
      releaseManifest.tag !== spec.tag
    )
      throw new Error("Release 清单与当前配方不一致");
    const build = releaseManifest.builds.find((entry) => entry.platform === platform);
    if (!build || build.archive.name !== component + "-" + platform + ".zip")
      throw new Error("组件 Release 缺少当前平台");
    const asset = release.assets.find((entry) => entry.name === build.archive.name);
    if (!asset || asset.size !== build.archive.bytes) throw new Error("远端组件附件不完整");
    if (asset.digest && asset.digest !== "sha256:" + build.archive.sha256)
      throw new Error("GitHub 附件摘要不匹配");
    gh([
      "release",
      "download",
      spec.tag,
      "--repo",
      repository,
      "--pattern",
      build.archive.name,
      "--dir",
      download,
    ]);
    const archive = path.join(download, build.archive.name);
    const bytes = await readFile(archive);
    if (bytes.length !== build.archive.bytes || sha256(bytes) !== build.archive.sha256)
      throw new Error("组件下载 SHA-256 不一致");
    const extracted = path.join(download, "payload");
    // ZipFile 只解压常规文件；预先拒绝所有绝对路径、回溯、盘符和重复项。
    const zipScript = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$zip=[IO.Compression.ZipFile]::OpenRead($env:JAVM_COMPONENT_ARCHIVE)",
      "try {",
      "  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)",
      "  foreach($entry in $zip.Entries) {",
      "    $name=$entry.FullName.TrimEnd('/')",
      "    if (!$name -or $name -match '(^/|\\\\|:|(^|/)\\.\\.?(/|$)|//)' -or !$seen.Add($name)) { throw 'Unsafe ZIP entry' }",
      "  }",
      "} finally { $zip.Dispose() }",
      "[IO.Compression.ZipFile]::ExtractToDirectory($env:JAVM_COMPONENT_ARCHIVE,$env:JAVM_COMPONENT_STAGE)",
    ].join("\n");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", zipScript], {
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, JAVM_COMPONENT_ARCHIVE: archive, JAVM_COMPONENT_STAGE: extracted },
    });
    const manifest = await readJson(path.join(extracted, "manifest.json"));
    await verifyPayload(extracted, manifest, spec, platform);
    if (
      JSON.stringify(manifest) !==
      JSON.stringify(Object.fromEntries(Object.entries(build).filter(([key]) => key !== "archive")))
    ) {
      throw new Error("ZIP 内外组件清单不一致");
    }
    record = {
      tag: spec.tag,
      releaseId: release.id,
      url: release.html_url,
      archive: build.archive,
      payload: path.relative(root, extracted).replaceAll("\\", "/"),
      manifest,
    };
    await writeFile(cachedRelease, JSON.stringify(record, null, 2) + "\n");
  }
  const payload = safePath(root, record.payload);
  await verifyPayload(payload, record.manifest, spec, platform);
  await verifyRuntime(payload, record.manifest);
  for (const file of record.manifest.files) {
    let destination;
    if (file.path.startsWith("runtime/")) {
      const base =
        component === "mediainfo"
          ? "bin"
          : component === "metatube"
            ? "bin/tools/metatube"
            : "bin/tools";
      destination = safePath(root, base + "/" + file.path.slice("runtime/".length));
    } else if (file.path.startsWith("licenses/")) {
      const base = ["ffmpeg", "metatube"].includes(component)
        ? "bin/licenses/" + component + "-lite"
        : "bin/licenses";
      destination = safePath(root, base + "/" + file.path.slice("licenses/".length));
    }
    if (destination) await copyChecked(safePath(payload, file.path), destination, file);
  }
  if (component === "mediainfo" || component === "curl")
    sdk[component] = payload.replaceAll("\\", "/");
  resolved.components[component] = {
    tag: record.tag,
    releaseId: record.releaseId,
    url: record.url,
    fingerprint: spec.fingerprint,
    version: spec.version,
    archive: record.archive,
    commit: record.manifest.commit,
    workflowRun: record.manifest.workflowRun,
  };
  console.log(component + ": 已验证并复用 " + record.tag);
}
await mkdir(path.dirname(resolvedPath), { recursive: true });
await writeFile(resolvedPath, JSON.stringify(resolved, null, 2) + "\n");
await writeFile(
  path.join(root, "build/dependencies/paths.cmake"),
  "# Generated after verifying the published component payloads.\n" +
    "set(JAVM_PREBUILT_MEDIAINFO [==[" +
    sdk.mediainfo +
    "]==])\n" +
    "set(JAVM_PREBUILT_CURL [==[" +
    sdk.curl +
    "]==])\n",
);
