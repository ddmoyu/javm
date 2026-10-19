import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "../components.mjs";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const targets = ["linux-x64", "macos-x64", "macos-arm64"];
export const target = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`;
export const components = ["curl", "mediainfo", "ffmpeg", "metatube", "neutralino"];
export const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const environment = {
  ...process.env,
  ...(process.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "13.0" } : {}),
};
export async function run(command, args, cwd = root, capture = false, env = environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let text = "",
      error = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error = (error + chunk).slice(-8192);
      });
    }
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve((text + (capture === "both" ? error : "")).trim())
        : reject(new Error(`${command} 退出码 ${code}: ${error}`)),
    );
  });
}
export async function download(source) {
  const file = path.join(root, ".tmp/offline-dependencies", source.file);
  try {
    if (sha256(await readFile(file)) === source.sha256) return file;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`源码下载失败: ${source.file} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== source.sha256) throw new Error(`源码校验失败: ${source.file}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}
export function inside(base, relative) {
  if (
    !relative ||
    /[\\\0\r\n]/.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("组件内路径无效");
  const result = path.resolve(base, relative);
  if (!result.startsWith(path.resolve(base) + path.sep)) throw new Error("组件内路径越界");
  return result;
}
export async function inventory(base, directory = "") {
  const result = [];
  for (const entry of await readdir(path.join(base, directory), { withFileTypes: true })) {
    const name = directory ? `${directory}/${entry.name}` : entry.name;
    const file = inside(base, name);
    if (entry.isDirectory()) result.push(...(await inventory(base, name)));
    else if (entry.isFile())
      result.push({
        path: name,
        bytes: (await lstat(file)).size,
        sha256: sha256(await readFile(file)),
        mode: (await lstat(file)).mode & 0o777,
      });
    else throw new Error(`组件内不接受链接或特殊文件: ${name}`);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifyInventory(base, manifest) {
  const names = new Set();
  for (const entry of manifest.files) {
    if (names.has(entry.path)) throw new Error("组件清单包含重复文件");
    names.add(entry.path);
    const file = inside(base, entry.path);
    const stats = await lstat(file);
    if (
      !stats.isFile() ||
      stats.size !== entry.bytes ||
      sha256(await readFile(file)) !== entry.sha256
    )
      throw new Error(`组件附件内容不匹配: ${entry.path}`);
    if (entry.mode & 0o111) await chmod(file, 0o755);
  }
  const actual = (await inventory(base)).filter((entry) => entry.path !== "manifest.json");
  if (actual.length !== manifest.files.length) throw new Error("组件内存在未记录的文件");
}
export async function specification(component, platform = target) {
  if (!components.includes(component) || !targets.includes(platform))
    throw new Error("不支持的组件或平台");
  const sources = await json(path.join(root, "scripts/offline-dependencies.json"));
  const extra = await json(path.join(root, "scripts/third-party/posix/sources.json"));
  const common = [
    "scripts/third-party/posix/common.mjs",
    "scripts/third-party/posix/build.mjs",
    "scripts/third-party/posix/verify.mjs",
  ];
  const names = {
    curl: ["scripts/third-party/posix/curl/CMakeLists.txt"],
    mediainfo: [
      "scripts/third-party/posix/mediainfo/CMakeLists.txt",
      "native/media/mediainfo/CMakeLists.txt",
    ],
    ffmpeg: ["scripts/third-party/posix/ffmpeg.sh"],
    metatube: [
      "scripts/build-metatube-lite.mjs",
      "scripts/metatube-lite-profile.mjs",
      "scripts/metatube-lite/source-lock.json",
      "scripts/metatube-lite/diagnostics.mjs",
      "scripts/metatube-lite/diagnostics/engine.go",
      "scripts/metatube-lite/diagnostics/route.go",
      "tests/fixtures/metatube-diagnostics/engine_test.go",
      "tests/fixtures/metatube-diagnostics/route_test.go",
    ],
    neutralino: [
      "scripts/third-party/posix/patch-neutralino.mjs",
      "scripts/third-party/posix/verify-host.mjs",
    ],
  };
  const files = Object.fromEntries(
    await Promise.all(
      [...common, ...names[component]].map(async (name) => [
        name,
        sha256((await readFile(path.join(root, name), "utf8")).replaceAll("\r\n", "\n")),
      ]),
    ),
  );
  const inputs = {
    schema: 1,
    component,
    platform,
    baseline: platform.startsWith("macos") ? "macOS 13.0" : "Ubuntu 24.04",
    environment: {
      runner:
        platform === "linux-x64"
          ? "ubuntu-24.04"
          : platform === "macos-x64"
            ? "macos-15-intel"
            : "macos-15",
      configuration: "Release",
      revision: 1,
    },
    sources: {
      [component]: component === "neutralino" ? extra.neutralino : sources[component],
      ...(component === "curl" ? { openssl: extra.openssl } : {}),
      ...(component === "ffmpeg" ? { ffmpegReference: sources.ffmpegReference } : {}),
    },
    files,
  };
  const fingerprint = sha256(canonical(inputs));
  return {
    component,
    platform,
    fingerprint,
    tag: `deps-${component}-${platform}-${fingerprint.slice(0, 16)}`,
    inputs,
  };
}
