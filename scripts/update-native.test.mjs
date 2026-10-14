import assert from "node:assert/strict";
import { test } from "node:test";
import { createECDH, createPrivateKey, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  installationReceipt,
  updateArchive,
  hashFile,
  signManifest,
  verifyManifest,
  platformVersion,
} from "./update-format.mjs";
import { updateManifest } from "./update-release.mjs";
const run = promisify(execFile);
const build =
  process.env.JAVM_UPDATE_FIXTURES ||
  `build/native/${process.platform === "win32" ? "windows-msvc" : process.platform === "darwin" ? "macos-app" : "linux-app"}/update-fixtures`;
const suffix = process.platform === "win32" ? ".exe" : "";
const updater = path.resolve(build, "javm_updater_fixture" + suffix),
  app = path.resolve(build, "javm_update_app_fixture" + suffix);
const platform =
  process.platform === "win32"
    ? "windows-x64"
    : process.platform === "darwin"
      ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
      : "linux-x64";
// 公开测试标量，仅匹配 javm_updater_fixture，生产资源从不引用它。
const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(Buffer.alloc(32, 1));
const point = ecdh.getPublicKey();
const privateKey = createPrivateKey({
  format: "jwk",
  key: {
    kty: "EC",
    crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33).toString("base64url"),
    d: Buffer.alloc(32, 1).toString("base64url"),
  },
}).export({ type: "pkcs8", format: "pem" });
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, JSON.stringify(value));
async function fixture(mode) {
  await mkdir(".tmp", { recursive: true });
  const base = await mkdtemp(path.resolve(".tmp", "update-safe-"));
  const root = path.join(base, "安全 安装"),
    dataRoot = path.join(base, "数据"),
    settings = path.join(base, "配置/.storage"),
    stage = path.join(base, "payload");
  const transaction = path.join(dataRoot, "updates", randomBytes(16).toString("hex"));
  for (const dir of [root, dataRoot, settings, stage, transaction])
    await mkdir(dir, { recursive: true });
  const entry = path.join(root, "JAVM" + suffix);
  await copyFile(app, entry);
  await chmod(entry, 0o755);
  await writeFile(path.join(root, "old-only.txt"), "old-runtime");
  await writeFile(path.join(root, "user-file.txt"), "safe-user-data");
  await save(path.join(root, "fixture-mode.json"), { mode: "old" });
  for (const name of ["library.sqlite3", "downloads-v1.sqlite3"]) {
    const db = new DatabaseSync(path.join(dataRoot, name));
    db.exec(
      "CREATE TABLE fixture(value TEXT);INSERT INTO fixture VALUES ('old-safe-value');PRAGMA user_version=1;",
    );
    db.close();
  }
  await save(path.join(settings, "preferences.json"), { value: "old-safe-value" });
  await copyFile(app, path.join(stage, "JAVM" + suffix));
  await chmod(path.join(stage, "JAVM" + suffix), 0o755);
  await save(path.join(stage, "fixture-mode.json"), { mode });
  await writeFile(path.join(stage, "new-only.txt"), "new-runtime");
  await installationReceipt(stage, "99.0.0-beta.2", "portable");
  const archive = path.join(transaction, "package.jup");
  const files = await updateArchive(stage, archive);
  const manifest = {
    schema: 1,
    app: "net.ddmoyu.javm",
    version: "99.0.0-beta.2",
    channel: "beta",
    minimumUpdater: 1,
    assets: [
      {
        platform,
        kind: "portable",
        name: "JAVM-fixture.jup",
        bytes: (await stat(archive)).size,
        sha256: await hashFile(archive),
      },
    ],
  };
  const job = {
    root,
    appPath: root,
    dataRoot,
    settings,
    kind: "portable",
    entry,
    ownerPid: 0,
    extensionPid: 0,
    version: manifest.version,
    currentVersion: "99.0.0-beta.1",
    owned: ["JAVM" + suffix, "old-only.txt", "fixture-mode.json"],
    files,
    envelope: signManifest(manifest, privateKey),
  };
  await save(path.join(transaction, "job.json"), job);
  await save(path.join(transaction, "status.json"), { phase: "ready", version: manifest.version });
  await save(path.join(transaction, "exit-ready.json"), { ready: true });
  return { base, root, dataRoot, settings, transaction, job, archive, manifest };
}
async function cleanup(f) {
  await delay(400);
  await rm(f.base, { recursive: true, force: true });
}
function dbValue(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM fixture").get().value;
  } finally {
    db.close();
  }
}
test("正式和 Beta 的平台版本及签名清单", () => {
  assert.equal(platformVersion("1.2.0-beta.3", "deb"), "1.2.0~beta.3");
  assert.equal(platformVersion("1.2.0-beta.3", "macos"), "1.2.0b3");
  const signed = signManifest({ version: "1.2.0" }, privateKey);
  assert.equal(verifyManifest(signed, privateKey), true);
  assert.equal(verifyManifest({ ...signed, payload: signed.payload + " " }, privateKey), false);
  assert.throws(() => updateManifest("1.2.0-alpha.1", []));
  assert.throws(() => updateManifest("1.2.0-beta.1", []));
});
test("健康启动提交后保留新版数据，恢复命令不会再降级", async () => {
  const f = await fixture("ok");
  try {
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 30000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "committed");
    assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "new-safe-value");
    await run(updater, ["--recover", f.transaction], { windowsHide: true, timeout: 10000 });
    assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "new-safe-value");
    assert.equal(await readFile(path.join(f.root, "user-file.txt"), "utf8"), "safe-user-data");
  } finally {
    await cleanup(f);
  }
});
test("新版启动失败恢复程序、两份数据库、设置，保留失败副本", async () => {
  const f = await fixture("fail");
  try {
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 30000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "rolled-back");
    for (const name of ["library.sqlite3", "downloads-v1.sqlite3"])
      assert.equal(dbValue(path.join(f.dataRoot, name)), "old-safe-value");
    assert.equal((await json(path.join(f.settings, "preferences.json"))).value, "old-safe-value");
    assert.equal(await readFile(path.join(f.root, "old-only.txt"), "utf8"), "old-runtime");
    await assert.rejects(stat(path.join(f.root, "new-only.txt")));
    await save(path.join(f.settings, "preferences.json"), { value: "after-rollback" });
    await run(updater, ["--recover", f.transaction], { windowsHide: true, timeout: 10000 });
    assert.equal((await json(path.join(f.settings, "preferences.json"))).value, "after-rollback");
  } finally {
    await cleanup(f);
  }
});

test("提交标记写入失败时仍监管新版进程并恢复旧数据", async () => {
  const f = await fixture("ok");
  try {
    // 制造提交文件无法写入，不能先放弃对子进程的监管。
    await mkdir(path.join(f.transaction, "commit.json.tmp"));
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 30000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "rolled-back");
    assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "old-safe-value");
    assert.equal(dbValue(path.join(f.dataRoot, "downloads-v1.sqlite3")), "old-safe-value");
    await assert.rejects(stat(path.join(f.transaction, "commit.json")));
  } finally {
    await cleanup(f);
  }
});

test("退出收尾取消后不替换程序、不修改数据库并保留就绪包", async () => {
  const f = await fixture("ok");
  try {
    await save(path.join(f.transaction, "exit-cancelled.json"), { cancelled: true });
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 10000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "ready");
    assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "old-safe-value");
    await assert.rejects(stat(path.join(f.transaction, "mutation.json")));
  } finally {
    await cleanup(f);
  }
});
test("失败版本记录无法写入时仍恢复程序和数据", async () => {
  const f = await fixture("fail");
  try {
    await mkdir(path.join(f.dataRoot, "updates/failed.json.tmp"));
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 30000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "rolled-back");
    for (const name of ["library.sqlite3", "downloads-v1.sqlite3"])
      assert.equal(dbValue(path.join(f.dataRoot, name)), "old-safe-value");
    assert.equal((await json(path.join(f.settings, "preferences.json"))).value, "old-safe-value");
    assert.equal(await readFile(path.join(f.root, "old-only.txt"), "utf8"), "old-runtime");
  } finally {
    await cleanup(f);
  }
});
test("中断恢复可重入，损坏快照会停止而保留原始资料", async () => {
  const f = await fixture("fail");
  try {
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 30000 });
    await save(path.join(f.transaction, "status.json"), {
      phase: "installing",
      needsRecovery: true,
    });
    await writeFile(path.join(f.root, "old-only.txt"), "interrupted-runtime");
    await run(updater, ["--recover", f.transaction], { windowsHide: true, timeout: 10000 });
    assert.equal(await readFile(path.join(f.root, "old-only.txt"), "utf8"), "old-runtime");
    await save(path.join(f.transaction, "status.json"), {
      phase: "rolling-back",
      needsRecovery: true,
    });
    await writeFile(path.join(f.transaction, "data/library.sqlite3"), "corrupt-safe-fixture");
    await assert.rejects(
      run(updater, ["--recover", f.transaction], { windowsHide: true, timeout: 10000 }),
    );
    assert.equal((await json(path.join(f.transaction, "status.json"))).needsRecovery, true);
    assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "old-safe-value");
  } finally {
    await cleanup(f);
  }
});
test("拒绝篡改签名和包内容，安装及数据尚未开始修改", async () => {
  const f = await fixture("ok");
  try {
    await save(path.join(f.transaction, "job.json"), {
      ...f.job,
      envelope: { ...f.job.envelope, signature: "0".repeat(128) },
    });
    await assert.rejects(
      run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 10000 }),
    );
    await save(path.join(f.transaction, "job.json"), f.job);
    await writeFile(f.archive, "tampered-safe-package");
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 10000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "failed");
    assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "old-safe-value");
    await assert.rejects(stat(path.join(f.transaction, "mutation.json")));
  } finally {
    await cleanup(f);
  }
});
test("即使签名可信也拒绝归档路径穿越", async () => {
  const f = await fixture("ok");
  try {
    const header = Buffer.from(
      JSON.stringify({
        schema: 1,
        files: [{ path: "../escape.txt", bytes: 0, sha256: "0".repeat(64) }],
      }),
    );
    const prefix = Buffer.alloc(12);
    prefix.write("JAVMUP1\n");
    prefix.writeUInt32LE(header.length, 8);
    await writeFile(f.archive, Buffer.concat([prefix, header]));
    f.manifest.assets[0].bytes = (await stat(f.archive)).size;
    f.manifest.assets[0].sha256 = await hashFile(f.archive);
    await save(path.join(f.transaction, "job.json"), {
      ...f.job,
      envelope: signManifest(f.manifest, privateKey),
    });
    await run(updater, ["--apply", f.transaction], { windowsHide: true, timeout: 10000 });
    assert.equal((await json(path.join(f.transaction, "status.json"))).phase, "failed");
    await assert.rejects(stat(path.join(f.transaction, "escape.txt")));
    await assert.rejects(stat(path.join(f.transaction, "mutation.json")));
  } finally {
    await cleanup(f);
  }
});
