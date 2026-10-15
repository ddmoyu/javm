import assert from "node:assert/strict";
import { test } from "node:test";
import { posixAssetNames } from "./release-notes.mjs";
import { validatePosixRecord } from "./release-posix.mjs";

function fixture(platform = "linux-x64") {
  const options = {
    platform,
    version: "1.0.5-alpha.9",
    commit: "a".repeat(40),
    manifestSha256: "b".repeat(64),
  };
  const manifest = {
    schema: 1,
    ...options,
    sourceCommit: options.commit,
    sourceDirty: false,
    assets: Object.values(posixAssetNames(options.version, platform)).map((name) => ({
      name,
      bytes: 10,
      sha256: "c".repeat(64),
    })),
  };
  const verification = {
    platform,
    sourceCommit: options.commit,
    manifestSha256: options.manifestSha256,
    completed: ["portable", "restart", "install", "overwrite"],
    safeDataOnly: true,
    preservedUserData: true,
    gui: true,
    desktop: {
      platform,
      sourceCommit: options.commit,
      gui: true,
      cookieIsolation: true,
      reports: [
        { done: true, errors: [] },
        { done: true, errors: [] },
      ],
    },
  };
  return { options, manifest, verification };
}
test("接受同一提交并经过桌面与安装验证的三个目标", () => {
  for (const platform of ["linux-x64", "macos-arm64", "macos-x64"]) {
    const { manifest, verification, options } = fixture(platform);
    validatePosixRecord(manifest, verification, options);
  }
});
test("拒绝混入其他提交、未提交源码、缺少便携包或过期清单", () => {
  for (const corrupt of [
    (value) => {
      value.manifest.sourceCommit = "d".repeat(40);
    },
    (value) => {
      value.manifest.sourceDirty = true;
    },
    (value) => {
      value.manifest.assets.pop();
    },
    (value) => {
      value.verification.manifestSha256 = "e".repeat(64);
    },
  ]) {
    const value = fixture();
    corrupt(value);
    assert.throws(() => validatePosixRecord(value.manifest, value.verification, value.options));
  }
});
test("无界面启动不能代替桌面验证，错误或残留会话也阻止发布", () => {
  for (const corrupt of [
    (value) => {
      value.verification.gui = false;
    },
    (value) => {
      value.verification.desktop.cookieIsolation = false;
    },
    (value) => {
      value.verification.desktop.reports[0].errors.push("safe failure");
    },
    (value) => {
      value.verification.preservedUserData = false;
    },
  ]) {
    const value = fixture();
    corrupt(value);
    assert.throws(() => validatePosixRecord(value.manifest, value.verification, value.options));
  }
});
