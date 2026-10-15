import assert from "node:assert/strict";
import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { components, json, sha256, specification, targets } from "./third-party/posix/common.mjs";
import { posixAssetNames } from "./release-notes.mjs";

export function validatePosixRecord(
  manifest,
  verification,
  { version, commit, platform, manifestSha256 },
) {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.version, version);
  assert.equal(manifest.platform, platform);
  assert.equal(manifest.sourceCommit, commit);
  assert.equal(manifest.sourceDirty, false, "拒绝未提交的 POSIX 构建");
  assert.equal(verification.platform, platform);
  assert.equal(verification.sourceCommit, commit);
  assert.equal(verification.manifestSha256, manifestSha256);
  assert.equal(verification.safeDataOnly, true);
  assert.equal(verification.preservedUserData, true);
  assert.ok(verification.completed.length >= 4, "安装与便携验证记录不完整");
  assert.equal(verification.gui, true);
  assert.equal(verification.desktop.gui, true);
  assert.equal(verification.desktop.sourceCommit, commit);
  assert.equal(verification.desktop.platform, platform);
  assert.equal(verification.desktop.cookieIsolation, true);
  assert.equal(verification.desktop.reports.length, 2);
  assert.ok(
    verification.desktop.reports.every(
      (report) => report.done && !report.fatal && !report.errors.length,
    ),
  );
  const update = `JAVM-${version}-${platform}-update.jup`;
  const expected = [
    ...Object.values(posixAssetNames(version, platform)),
    ...(!version.includes("-alpha.") && platform.startsWith("macos-")
      ? [`JAVM-${version}-${platform}-legacy.app.tar.gz`]
      : []),
    ...(!version.includes("-alpha.") || manifest.assets.some((asset) => asset.name === update)
      ? [update]
      : []),
  ];
  assert.deepEqual(
    manifest.assets.map((asset) => asset.name).sort((a, b) => a.localeCompare(b)),
    expected.sort((a, b) => a.localeCompare(b)),
    "安装包或便携包不完整",
  );
  for (const asset of manifest.assets) {
    assert.equal(path.basename(asset.name), asset.name);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
  }
}

export async function collectPosixArtifacts({ version, commit, source, destination }) {
  const planned = [];
  for (const platform of targets) {
    const directory = path.join(source, `javm-development-${platform}`);
    const name = `JAVM-${version}-${platform}-manifest.json`;
    const manifest = await json(path.join(directory, name));
    const verification = await json(path.join(directory, "verification.json"));
    validatePosixRecord(manifest, verification, {
      version,
      commit,
      platform,
      manifestSha256: sha256(await readFile(path.join(directory, name))),
    });
    for (const component of components) {
      const spec = await specification(component, platform),
        release = manifest.components[component];
      assert.equal(release.fingerprint, spec.fingerprint, "组件配方不匹配");
      assert.equal(release.tag, spec.tag);
      assert.ok(Number.isSafeInteger(release.releaseId) && release.releaseId > 0);
      assert.match(release.archive.sha256, /^[a-f0-9]{64}$/);
    }
    for (const asset of manifest.assets) {
      const file = path.join(directory, asset.name);
      assert.equal((await stat(file)).size, asset.bytes);
      assert.equal(sha256(await readFile(file)), asset.sha256, "POSIX 附件在验证后发生变化");
      planned.push({ source: file, name: asset.name, bytes: asset.bytes, sha256: asset.sha256 });
    }
    for (const [from, to] of [
      [name, name],
      ["verification.json", `${platform}-verification.json`],
      ["INSTALL.txt", `${platform}-INSTALL.txt`],
    ]) {
      const file = path.join(directory, from),
        data = await readFile(file);
      planned.push({ source: file, name: to, bytes: data.length, sha256: sha256(data) });
    }
  }
  assert.equal(new Set(planned.map((item) => item.name)).size, planned.length);
  for (const item of planned) await copyFile(item.source, path.join(destination, item.name));
  return planned.map(({ source: _source, ...item }) => item);
}
