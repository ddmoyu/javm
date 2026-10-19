import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "./identity.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const platforms = {
  "windows-x64": "windows-2025",
  "linux-x64": "ubuntu-24.04",
  "macos-x64": "macos-15-intel",
  "macos-arm64": "macos-15",
};

// Each component owns its recipe file. Adding a patch/test to one recipe must
// not change the fingerprints of the other components in the same registry.
export async function currentSpecification(component, platform, sourceRoot = root) {
  if (!platforms[platform] || !/^[a-z]+$/.test(component)) throw new Error("不支持的组件或平台");
  const windows = platform === "windows-x64";
  const read = async (name) =>
    (await readFile(path.join(sourceRoot, name), "utf8")).replaceAll("\r\n", "\n");
  const recipeFile = `scripts/third-party/recipes/${windows ? "windows" : "posix"}/${component}.json`;
  const recipe = JSON.parse(await read(recipeFile));
  const sources = JSON.parse(await read("scripts/offline-dependencies.json"));
  if (!windows)
    Object.assign(sources, JSON.parse(await read("scripts/third-party/posix/sources.json")));
  const common = windows
    ? [
        "scripts/third-party/components.mjs",
        "scripts/third-party/build.ps1",
        "scripts/third-party/package.mjs",
        "scripts/third-party/verify.mjs",
      ]
    : [
        "scripts/third-party/posix/common.mjs",
        "scripts/third-party/posix/build.mjs",
        "scripts/third-party/posix/verify.mjs",
      ];
  const files = {};
  for (const name of [
    "scripts/third-party/identity.mjs",
    "scripts/third-party/fingerprint.mjs",
    recipeFile,
    ...common,
    ...recipe.files,
  ]) {
    if (!name.startsWith("scripts/") && !name.startsWith("native/") && !name.startsWith("tests/"))
      throw new Error("组件配方文件路径无效");
    if (
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\:]/.test(name)
    )
      throw new Error("组件配方文件路径无效");
    files[name] = sha256(await read(name));
  }
  const inputs = {
    schema: 2,
    component,
    ...(windows
      ? { platforms: [platform] }
      : { platform, baseline: platform.startsWith("macos") ? "macOS 13.0" : "Ubuntu 24.04" }),
    environment: {
      runner: platforms[platform],
      ...(windows ? { compiler: "MSVC" } : {}),
      configuration: "Release",
      ...(windows ? { nasm: "2.16.03" } : {}),
      revision: 1,
    },
    sources: Object.fromEntries(
      recipe.sources.map((name) => {
        if (!sources[name]) throw new Error("组件缺少锁定来源：" + name);
        return [name, sources[name]];
      }),
    ),
    files,
  };
  const fingerprint = sha256(canonical(inputs));
  const version = sources[component].version.replace(/^v/, "");
  return {
    component,
    ...(windows ? { version } : { platform }),
    fingerprint,
    tag: windows
      ? `deps-${component}-${version}-${fingerprint.slice(0, 12)}`
      : `deps-${component}-${platform}-${fingerprint.slice(0, 16)}`,
    inputs,
  };
}

export function reuseRecordedSpecification(current, record) {
  if (!record || record.recipeFingerprint !== current.fingerprint) return current;
  // One-time, reviewed migration of the existing v1 releases. This is an exact
  // input-hash match, never a latest-version fallback or an edited manifest.
  const previous = record.specification;
  assert.equal(sha256(canonical(previous.inputs)), previous.fingerprint);
  for (const key of ["component", "platform", "version"])
    assert.equal(previous[key], current[key], "组件迁移身份不匹配");
  for (const key of ["sources", "environment", "baseline", "platforms", "platform"])
    assert.deepEqual(previous.inputs[key], current.inputs[key], "组件迁移配方不匹配");
  const prefix = current.platform
    ? `deps-${current.component}-${current.platform}-`
    : `deps-${current.component}-${current.version}-`;
  assert.equal(previous.tag, prefix + previous.fingerprint.slice(0, current.platform ? 16 : 12));
  return previous;
}

export async function componentSpecification(component, platform) {
  const current = await currentSpecification(component, platform);
  const migration = JSON.parse(
    await readFile(path.join(root, "scripts/third-party/reuse-v1.json"), "utf8"),
  );
  assert.equal(migration.schema, 1);
  return reuseRecordedSpecification(current, migration.entries[`${platform}/${component}`]);
}
