import assert from "node:assert/strict";
import test from "node:test";
import { posixAssetNames, releaseAssetNames, renderReleaseNotes } from "./release-notes.mjs";
const version = "1.0.5-alpha.9";
const assets = [
  ...Object.values(releaseAssetNames(version)),
  ...["macos-arm64", "macos-x64", "linux-x64"].flatMap((target) =>
    Object.values(posixAssetNames(version, target)),
  ),
];
test("跨平台表格只列出真实附件，包含系统基线和两种 Mac 架构", () => {
  const notes = renderReleaseNotes({
    version,
    changes: "- 安全测试条目。",
    repository: "example/safe",
    assets,
  });
  for (const asset of assets) assert.ok(notes.includes(`releases/download/v${version}/${asset}`));
  assert.match(notes, /macOS 13\+/);
  assert.match(notes, /Apple Silicon/);
  assert.match(notes, /Intel x64/);
  assert.match(notes.trim().split("\n").at(-1), /^\| Ubuntu 24\.04/);
  assert.ok(!notes.includes("Android"));
});
test("同平台缺少安装或便携附件时拒绝发布占位入口", () => {
  for (const name of assets)
    assert.throws(
      () =>
        renderReleaseNotes({
          version,
          changes: "safe",
          repository: "example/safe",
          assets: assets.filter((asset) => asset !== name),
        }),
      /缺少对应附件/,
    );
});
