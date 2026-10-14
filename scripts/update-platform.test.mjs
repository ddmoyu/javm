// 仅在一次性 CI 系统中安装安全夹具；没有业务 UI、远端内容或真实数据库。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createECDH, createPrivateKey, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { installationReceipt, updateArchive, hashFile, signManifest } from "./update-format.mjs";
import { download } from "./third-party/posix/common.mjs";
const run = promisify(execFile);
const exec = (file, args, options = {}) => run(file, args, { timeout: 60000, ...options });
const mac = process.platform === "darwin";
const linux = process.platform === "linux";
const enabled = process.env.GITHUB_ACTIONS === "true" && (mac || linux);
const platform = mac ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}` : "linux-x64";
const build = path.resolve(
  process.env.JAVM_UPDATE_FIXTURES ||
    `build/native/${mac ? "macos" : "linux"}-release/update-fixtures`,
);
const updater = path.join(build, "javm_updater_fixture");
const app = path.join(build, "javm_update_app_fixture");
const point = createECDH("prime256v1");
point.setPrivateKey(Buffer.alloc(32, 1));
const publicKey = point.getPublicKey();
const privateKey = createPrivateKey({
  format: "jwk",
  key: {
    kty: "EC",
    crv: "P-256",
    d: Buffer.alloc(32, 1).toString("base64url"),
    x: publicKey.subarray(1, 33).toString("base64url"),
    y: publicKey.subarray(33).toString("base64url"),
  },
}).export({ type: "pkcs8", format: "pem" });
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, JSON.stringify(value));
function dbValue(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM fixture").get().value;
  } finally {
    db.close();
  }
}
async function payload(root, mode, kind, version) {
  const bin = kind === "app" ? path.join(root, "Contents/MacOS") : root;
  await mkdir(bin, { recursive: true });
  await copyFile(app, path.join(bin, "JAVM"));
  await chmod(path.join(bin, "JAVM"), 0o755);
  const resources = kind === "app" ? path.join(root, "Contents/Resources") : root;
  await mkdir(resources, { recursive: true });
  await save(path.join(resources, "fixture-mode.json"), { mode });
  if (kind === "app") {
    await writeFile(
      path.join(root, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>net.ddmoyu.javm</string><key>CFBundleName</key><string>JAVM Safe Fixture</string><key>CFBundleExecutable</key><string>JAVM</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
  }
  await installationReceipt(
    root,
    version,
    kind,
    kind === "app" ? "Contents/Resources/update-installation.json" : "update-installation.json",
    kind === "app" ? ["Contents/_CodeSignature/CodeResources"] : [],
  );
  if (kind === "app") await exec("codesign", ["--force", "--sign", "-", root]);
  return bin;
}
async function signed(file, kind, version) {
  return signManifest(
    {
      schema: 1,
      app: "net.ddmoyu.javm",
      version,
      channel: "beta",
      minimumUpdater: 1,
      assets: [
        {
          platform,
          kind,
          name: `JAVM-${version}-${platform}-${kind}${path.extname(file)}`,
          bytes: (await stat(file)).size,
          sha256: await hashFile(file),
        },
      ],
    },
    privateKey,
  );
}
async function deb(base, source, destination, name, version, fail = false) {
  const tree = path.join(base, `deb-${version}`);
  await mkdir(path.join(tree, "DEBIAN"), { recursive: true });
  await cp(source, path.join(tree, destination.slice(1)), { recursive: true });
  await writeFile(
    path.join(tree, "DEBIAN/control"),
    `Package: ${name}\nVersion: ${version}\nArchitecture: amd64\nMaintainer: JAVM fixture <noreply@example.invalid>\nDescription: Safe isolated update fixture\n`,
  );
  if (fail)
    await writeFile(path.join(tree, "DEBIAN/postinst"), "#!/bin/sh\nexit 23\n", { mode: 0o755 });
  const file = path.join(base, `${version}.deb`);
  await exec("dpkg-deb", ["--build", "--root-owner-group", tree, file]);
  return file;
}
async function appimage(base, source, name) {
  const dir = path.join(base, `${name}.AppDir`);
  await cp(source, dir, { recursive: true });
  await writeFile(
    path.join(dir, "AppRun"),
    '#!/bin/sh\nroot=$(CDPATH= cd -- "${0%/*}" && pwd)\nexec "$root/JAVM" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(dir, "fixture.desktop"),
    "[Desktop Entry]\nType=Application\nName=JAVM Safe Fixture\nExec=JAVM\nIcon=fixture\nCategories=Utility;\n",
  );
  await copyFile("resources/icon.png", path.join(dir, "fixture.png"));
  const tools = await json("scripts/third-party/posix/sources.json");
  const tool = await download(tools.appimagetool),
    runtime = await download(tools.appimageRuntime);
  await chmod(tool, 0o755);
  const file = path.join(base, `${name}.AppImage`);
  await exec(
    tool,
    ["--appimage-extract-and-run", "--runtime-file", runtime, "--no-appstream", dir, file],
    { env: { ...process.env, ARCH: "x86_64" } },
  );
  await chmod(file, 0o755);
  return file;
}
async function fixture(kind, mode) {
  await mkdir(".tmp", { recursive: true });
  const base = await mkdtemp(path.resolve(".tmp", "update-platform-"));
  const id = randomBytes(16).toString("hex"),
    dataRoot = path.join(base, "safe-data"),
    settings = path.join(base, "settings");
  const transaction = path.join(dataRoot, "updates", id);
  await mkdir(transaction, { recursive: true });
  await mkdir(settings);
  for (const name of ["library.sqlite3", "downloads-v1.sqlite3"]) {
    const db = new DatabaseSync(path.join(dataRoot, name));
    db.exec(
      "CREATE TABLE fixture(value TEXT);INSERT INTO fixture VALUES('old-safe-value');PRAGMA user_version=1;",
    );
    db.close();
  }
  await save(path.join(settings, "preferences.json"), { value: "old-safe-value" });
  const old = path.join(base, kind === "app" ? "JAVM.app" : "old"),
    next = path.join(base, kind === "app" ? "next/JAVM.app" : "next");
  const oldBin = await payload(old, "old", kind, "99.0.0-beta.1");
  await payload(next, mode, kind, "99.0.0-beta.2");
  let root = old,
    entry = path.join(oldBin, "JAVM"),
    archive,
    rollback,
    packageId;
  let files = [];
  if (kind === "app") {
    archive = path.join(transaction, "package.jup");
    files = await updateArchive(next, archive);
  } else if (kind === "appimage") {
    root = path.join(base, "installed");
    await mkdir(root);
    entry = path.join(root, "JAVM.AppImage");
    await copyFile(await appimage(base, old, "old"), entry);
    await chmod(entry, 0o755);
    archive = path.join(transaction, "package.AppImage");
    await copyFile(await appimage(base, next, "new"), archive);
  } else {
    assert.equal(kind, "deb");
    root = `/opt/JAVM-update-validation-${id}`;
    entry = path.join(root, "JAVM");
    packageId = `javm-update-validation-${id}`;
    const previous = await deb(base, old, root, packageId, "99.0.0~beta.1");
    await exec("sudo", ["dpkg", "-i", previous]);
    await copyFile(previous, path.join(transaction, "previous.deb"));
    rollback = await signed(path.join(transaction, "previous.deb"), kind, "99.0.0-beta.1");
    archive = path.join(transaction, "package.deb");
    await copyFile(
      await deb(base, next, root, packageId, "99.0.0~beta.2", mode === "install-fail"),
      archive,
    );
  }
  const receipt = await json(
    path.join(
      old,
      kind === "app" ? "Contents/Resources/update-installation.json" : "update-installation.json",
    ),
  );
  const job = {
    root,
    appPath: oldBin,
    dataRoot,
    settings,
    kind,
    entry,
    ownerPid: 0,
    extensionPid: 0,
    currentVersion: "99.0.0-beta.1",
    version: "99.0.0-beta.2",
    files,
    owned: receipt.owned,
    envelope: await signed(archive, kind, "99.0.0-beta.2"),
    rollback,
  };
  await save(path.join(transaction, "job.json"), job);
  await save(path.join(transaction, "status.json"), { phase: "ready" });
  await save(path.join(transaction, "exit-ready.json"), { ready: true });
  return {
    base,
    root,
    entry,
    dataRoot,
    settings,
    transaction,
    job,
    packageId,
    oldHash: await hashFile(entry),
  };
}
async function cleanup(f) {
  await delay(400);
  if (f.packageId) await exec("sudo", ["dpkg", "--purge", f.packageId]);
  if (mac) await exec("sudo", ["chown", "-R", `${process.getuid()}:${process.getgid()}`, f.base]);
  assert.equal(path.dirname(f.base), path.resolve(".tmp"));
  await rm(f.base, { recursive: true, force: true });
}
async function apply(f) {
  await exec(updater, ["--apply", f.transaction], {
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  return json(path.join(f.transaction, "status.json"));
}
async function assertRestored(f) {
  assert.equal(await hashFile(f.entry), f.oldHash);
  for (const name of ["library.sqlite3", "downloads-v1.sqlite3"])
    assert.equal(dbValue(path.join(f.dataRoot, name)), "old-safe-value");
  assert.equal((await json(path.join(f.settings, "preferences.json"))).value, "old-safe-value");
  if (mac) await exec("codesign", ["--verify", "--deep", "--strict", f.root]);
}
for (const kind of mac ? ["app"] : ["appimage", "deb"]) {
  for (const mode of ["ok", "fail", ...(kind === "deb" ? ["install-fail"] : [])]) {
    test(`${kind} 实际安装与 ${mode} 启动/安装结果`, { skip: !enabled }, async () => {
      const f = await fixture(kind, mode);
      try {
        const status = await apply(f);
        assert.equal(
          status.phase,
          mode === "ok" ? "committed" : "rolled-back",
          JSON.stringify(status),
        );
        if (mode === "ok")
          assert.equal(dbValue(path.join(f.dataRoot, "library.sqlite3")), "new-safe-value");
        else await assertRestored(f);
        if (kind === "deb")
          assert.equal(
            (await exec("dpkg-query", ["-W", "-f=${Version}", f.packageId])).stdout,
            mode === "ok" ? "99.0.0~beta.2" : "99.0.0~beta.1",
          );
        if (mac) await exec("codesign", ["--verify", "--deep", "--strict", f.root]);
      } finally {
        await cleanup(f);
      }
    });
  }
}
test("macOS root 私有暂存与回退不受用户快照篡改影响", { skip: !enabled || !mac }, async () => {
  const f = await fixture("app", "ok");
  try {
    await exec("sudo", ["chown", "-R", "root:wheel", f.root]);
    await exec("sudo", [updater, "--program", f.transaction]);
    await exec("codesign", ["--verify", "--deep", "--strict", f.root]);
    assert.equal(
      (await json(path.join(f.root, "Contents/Resources/fixture-mode.json"))).mode,
      "ok",
    );
    await mkdir(path.join(f.transaction, "previous/Contents/MacOS"), { recursive: true });
    await writeFile(
      path.join(f.transaction, "previous/Contents/MacOS/JAVM"),
      "tampered safe fixture",
    );
    await exec("sudo", [updater, "--rollback-program", f.transaction]);
    await assertRestored(f);
    assert.equal(
      (await json(path.join(f.root, "Contents/Resources/fixture-mode.json"))).mode,
      "old",
    );
  } finally {
    await cleanup(f);
  }
});
