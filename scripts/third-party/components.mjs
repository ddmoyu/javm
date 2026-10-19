import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const repository = "ddmoyu/javm";
export const platforms = ["windows-x64"];
export const components = ["ffmpeg", "metatube", "mediainfo", "curl"];
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const readJson = async (file) =>
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
export const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

const recipes = {
  ffmpeg: {
    sources: ["ffmpeg", "ffmpegReference", "msysMake"],
    files: [
      "scripts/build-ffmpeg-lite.ps1",
      "scripts/build-ffmpeg-lite.sh",
      "scripts/verify-ffmpeg-lite.mjs",
    ],
  },
  metatube: {
    sources: ["metatube"],
    files: [
      "scripts/build-metatube-lite.mjs",
      "scripts/metatube-lite-profile.mjs",
      "scripts/metatube-lite/source-lock.json",
      "scripts/metatube-lite/diagnostics.mjs",
      "scripts/metatube-lite/diagnostics/engine.go",
      "scripts/metatube-lite/diagnostics/route.go",
      "tests/fixtures/metatube-diagnostics/engine_test.go",
      "tests/fixtures/metatube-diagnostics/route_test.go",
      "scripts/verify-metatube-lite.mjs",
    ],
  },
  mediainfo: {
    sources: ["mediainfo"],
    files: [
      "scripts/third-party/mediainfo/CMakeLists.txt",
      "native/media/mediainfo/CMakeLists.txt",
      "native/media/mediainfo/write-receipt.cmake",
      "scripts/verify-mediainfo-lite.mjs",
      "scripts/third-party/verify-mediainfo.ps1",
    ],
  },
  curl: {
    sources: ["curl"],
    files: ["scripts/build-curl.ps1"],
  },
};

export async function specification(component) {
  if (!components.includes(component)) throw new Error("未知第三方组件：" + component);
  const dependencies = await readJson(path.join(root, "scripts/offline-dependencies.json"));
  const recipe = recipes[component];
  const files = {};
  for (const name of [
    ...recipe.files,
    "scripts/third-party/components.mjs",
    "scripts/third-party/build.ps1",
    "scripts/third-party/package.mjs",
    "scripts/third-party/verify.mjs",
  ]) {
    files[name] = sha256((await readFile(path.join(root, name), "utf8")).replaceAll("\r\n", "\n"));
  }
  const inputs = {
    schema: 1,
    component,
    platforms,
    environment: {
      runner: "windows-2025",
      compiler: "MSVC",
      configuration: "Release",
      nasm: "2.16.03",
      revision: 1,
    },
    sources: Object.fromEntries(recipe.sources.map((name) => [name, dependencies[name]])),
    files,
  };
  const fingerprint = sha256(canonical(inputs));
  const version = dependencies[component].version.replace(/^v/, "");
  return {
    component,
    version,
    fingerprint,
    tag: "deps-" + component + "-" + version + "-" + fingerprint.slice(0, 12),
    inputs,
  };
}

export function safePath(base, relative) {
  if (
    !relative ||
    /[\\:]/.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("非法组件路径：" + relative);
  }
  const resolved = path.resolve(base, ...relative.split("/"));
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error("组件路径越界");
  return resolved;
}

export async function inventory(directory, prefix = "") {
  const files = [];
  for (const item of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + "/" + item.name : item.name;
    if (item.isDirectory()) files.push(...(await inventory(directory, relative)));
    else if (item.isFile()) {
      const file = safePath(directory, relative);
      files.push({
        path: relative,
        bytes: (await stat(file)).size,
        sha256: sha256(await readFile(file)),
      });
    } else throw new Error("组件中不允许链接或特殊文件：" + relative);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifyPayload(directory, manifest, spec, platform) {
  if (
    manifest.schema !== 1 ||
    manifest.component !== spec.component ||
    manifest.fingerprint !== spec.fingerprint ||
    manifest.platform !== platform ||
    manifest.tag !== spec.tag ||
    manifest.version !== spec.version
  ) {
    throw new Error("组件版本、平台或构建指纹不匹配");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("组件文件清单为空");
  const names = new Set();
  for (const file of manifest.files) {
    const absolute = safePath(directory, file.path);
    const key = file.path.toLowerCase();
    if (names.has(key) || !/^(runtime|sdk|licenses|build)\//.test(file.path)) {
      throw new Error("重复或未允许的组件文件：" + file.path);
    }
    names.add(key);
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (await stat(absolute)).size !== file.bytes ||
      sha256(await readFile(absolute)) !== file.sha256
    ) {
      throw new Error("组件文件校验失败：" + file.path);
    }
  }
  const actual = (await inventory(directory)).filter((file) => file.path !== "manifest.json");
  if (canonical(actual) !== canonical(manifest.files)) throw new Error("组件包含清单之外的文件");
}
