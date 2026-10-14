import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createECDH, createPrivateKey, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { hashFile, installationReceipt, signManifest } from "./update-format.mjs";
const run = promisify(execFile);
const exec = (file, args) =>
  run(file, args, { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, JSON.stringify(value));
const build = path.resolve(
  process.env.JAVM_UPDATE_FIXTURES || "build/native/windows-msvc/update-fixtures",
);
const point = createECDH("prime256v1");
point.setPrivateKey(Buffer.alloc(32, 1));
const pub = point.getPublicKey();
const key = createPrivateKey({
  format: "jwk",
  key: {
    kty: "EC",
    crv: "P-256",
    d: Buffer.alloc(32, 1).toString("base64url"),
    x: pub.subarray(1, 33).toString("base64url"),
    y: pub.subarray(33).toString("base64url"),
  },
}).export({ format: "pem", type: "pkcs8" });
async function signed(file, version) {
  return signManifest(
    {
      schema: 1,
      app: "net.ddmoyu.javm",
      version,
      channel: "beta",
      minimumUpdater: 1,
      assets: [
        {
          platform: "windows-x64",
          kind: "setup",
          name: `JAVM-${version}-fixture.exe`,
          bytes: (await stat(file)).size,
          sha256: await hashFile(file),
        },
      ],
    },
    key,
  );
}
for (const mode of ["ok", "fail", "install-fail"]) {
  test(
    `Windows Setup 实际安装与 ${mode} 回退`,
    { skip: process.platform !== "win32" },
    async () => {
      await mkdir(".tmp", { recursive: true });
      const base = await mkdtemp(path.resolve(".tmp", "update-setup-")),
        id = randomBytes(4).toString("hex");
      const root = path.join(base, "safe-installed"),
        dataRoot = path.join(base, "safe-data"),
        settings = path.join(base, "settings");
      const transaction = path.join(dataRoot, "updates", randomBytes(16).toString("hex"));
      await mkdir(transaction, { recursive: true });
      await mkdir(settings);
      const setupArgs = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-", "/NORESTART", `/DIR=${root}`];
      const compiler =
        process.env.JAVM_ISCC ||
        path.join(process.env["ProgramFiles(x86)"], "Inno Setup 6/ISCC.exe");
      async function installer(version, mode, name) {
        const payload = path.join(base, name);
        await mkdir(payload);
        await copyFile(
          path.join(build, "javm_update_app_fixture.exe"),
          path.join(payload, "JAVM.exe"),
        );
        await save(path.join(payload, "fixture-mode.json"), { mode });
        await installationReceipt(payload, version, "setup");
        await writeFile(path.join(base, "notice.txt"), "Safe updater fixture");
        await exec(compiler, [
          "/Qp",
          `/DAppVersion=${version}`,
          "/DNumericVersion=99.0.0.1",
          `/DJavmAppId=net.ddmoyu.javm.update.${id}`,
          `/DJavmGroup=JAVM update ${id}`,
          `/DProjectRoot=${process.cwd()}`,
          `/DPayloadDirectory=${payload}`,
          `/DNoticesFile=${path.join(base, "notice.txt")}`,
          `/DOutputDirectory=${base}`,
          `/DOutputName=${name}`,
          path.resolve("scripts/installer/javm.iss"),
        ]);
        return path.join(base, name + ".exe");
      }
      const previous = await installer("99.0.0-beta.1", "old", "previous");
      await exec(previous, setupArgs);
      try {
        await writeFile(path.join(root, "user-file.txt"), "safe-user-file");
        for (const name of ["library.sqlite3", "downloads-v1.sqlite3"]) {
          const db = new DatabaseSync(path.join(dataRoot, name));
          db.exec(
            "CREATE TABLE fixture(value TEXT);INSERT INTO fixture VALUES('old-safe-value');PRAGMA user_version=1;",
          );
          db.close();
        }
        await save(path.join(settings, "preferences.json"), { value: "old-safe-value" });
        const packageFile = path.join(transaction, "package.exe");
        if (mode === "install-fail") await writeFile(packageFile, "safe invalid installer");
        else await copyFile(await installer("99.0.0-beta.2", mode, "next"), packageFile);
        await copyFile(previous, path.join(transaction, "previous.exe"));
        const job = {
          root,
          appPath: root,
          dataRoot,
          settings,
          kind: "setup",
          entry: path.join(root, "JAVM.exe"),
          ownerPid: 0,
          extensionPid: 0,
          currentVersion: "99.0.0-beta.1",
          version: "99.0.0-beta.2",
          files: [],
          owned: [],
          envelope: await signed(packageFile, "99.0.0-beta.2"),
          rollback: await signed(previous, "99.0.0-beta.1"),
        };
        await save(path.join(transaction, "job.json"), job);
        await save(path.join(transaction, "status.json"), { phase: "ready" });
        await save(path.join(transaction, "exit-ready.json"), { ready: true });
        await exec(path.join(build, "javm_updater_fixture.exe"), ["--apply", transaction]);
        const status = await json(path.join(transaction, "status.json"));
        assert.equal(
          status.phase,
          mode === "ok" ? "committed" : "rolled-back",
          JSON.stringify(status),
        );
        assert.equal(
          (await json(path.join(root, "update-installation.json"))).version,
          mode === "ok" ? "99.0.0-beta.2" : "99.0.0-beta.1",
        );
        for (const name of ["library.sqlite3", "downloads-v1.sqlite3"]) {
          const db = new DatabaseSync(path.join(dataRoot, name), { readOnly: true });
          assert.equal(
            db.prepare("SELECT value FROM fixture").get().value,
            mode === "ok" ? "new-safe-value" : "old-safe-value",
          );
          db.close();
        }
        assert.equal(
          (await json(path.join(settings, "preferences.json"))).value,
          mode === "ok" ? "new-safe-value" : "old-safe-value",
        );
        assert.equal(await readFile(path.join(root, "user-file.txt"), "utf8"), "safe-user-file");
      } finally {
        await exec(path.join(root, "unins000.exe"), [
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
        ]);
      }
    },
  );
}
