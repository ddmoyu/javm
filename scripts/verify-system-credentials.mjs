import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionFixture } from "../tests/fixtures/core-extension/host.mjs";
import { root, run } from "./third-party/posix/common.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "系统密钥库验证只在临时 CI 虚拟机运行");
assert.ok(["darwin", "linux"].includes(process.platform));
const binary = path.join(root, "bin/javm_database");
const directory =
  process.env.JAVM_SAFE_KEYRING_DIRECTORY ||
  (await mkdtemp(path.join(tmpdir(), "javm-safe-keyring-")));
assert.equal(path.dirname(directory), path.resolve(tmpdir()));
assert.match(path.basename(directory), /^javm-safe-keyring-/);
const password = "javm-safe-ci-fixture";
const keychain = path.join(directory, "fixture.keychain-db");
let oldDefault,
  oldSearch,
  created = false;
const hosts = [];
const security = (args) => run("security", args, directory, true);
async function host(environment = process.env) {
  const instance = new ExtensionFixture(
    binary,
    path.join(directory, `unused-${hosts.length}.sqlite3`),
    { env: environment, requestTimeoutMs: 17000 },
  );
  hosts.push(instance);
  await instance.start();
  return instance;
}
async function verify() {
  const first = await host();
  for (const key of ["javm-ai-settings-v1", "javm-metatube-settings-v1"]) {
    assert.equal(await first.request("platform.credentials.read", { key }), null);
    const value = JSON.stringify({ key: "SAFE-FICTIONAL-KEY", label: "安全 山林" });
    await first.request("platform.credentials.write", { key, value });
    assert.equal(await first.request("platform.credentials.read", { key }), value);
    const changed = JSON.stringify({ key: "SAFE-UPDATED-KEY" });
    await first.request("platform.credentials.write", { key, value: changed });
    assert.equal(await first.request("platform.credentials.read", { key }), changed);
  }
  await first.close();
  const restarted = await host();
  assert.equal(
    await restarted.request("platform.credentials.read", { key: "javm-ai-settings-v1" }),
    JSON.stringify({ key: "SAFE-UPDATED-KEY" }),
  );
  await restarted.close();
  if (process.platform === "darwin") await security(["lock-keychain", keychain]);
  const unavailable = await host(
    process.platform === "linux"
      ? { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/absent-bus` }
      : process.env,
  );
  const before = Date.now();
  const reply = await unavailable.reply("platform.credentials.read", {
    key: "javm-ai-settings-v1",
  });
  assert.equal(reply.ok, false, "锁定或不可用时不能回退明文或假报成功");
  assert.ok(Date.now() - before < 16000);
  assert.ok(!reply.error.includes("SAFE-UPDATED-KEY"));
  assert.ok(
    (await unavailable.request("platform.loopbackPort")).port > 0,
    "失败后接收线程仍然可用",
  );
  await unavailable.close();
  console.log(`${process.platform}: 系统密钥库读写、覆盖、重启及不可用错误通过`);
}
try {
  if (process.platform === "darwin") {
    oldDefault = (await security(["default-keychain", "-d", "user"])).trim().replace(/^"|"$/g, "");
    oldSearch = [
      ...(await security(["list-keychains", "-d", "user"])).matchAll(/"([^"\n]+)"/g),
    ].map((match) => match[1]);
    await security(["create-keychain", "-p", password, keychain]);
    created = true;
    await security(["unlock-keychain", "-p", password, keychain]);
    await security(["set-keychain-settings", "-lut", "3600", keychain]);
    await security(["list-keychains", "-d", "user", "-s", keychain]);
    await security(["default-keychain", "-d", "user", "-s", keychain]);
    await verify();
  } else if (!process.argv.includes("--session")) {
    const home = path.join(directory, "home");
    await mkdir(home);
    const runtime = path.join(directory, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    await run(
      "dbus-run-session",
      ["--", process.execPath, fileURLToPath(import.meta.url), "--session"],
      root,
      false,
      {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_RUNTIME_DIR: runtime,
        JAVM_SAFE_KEYRING_DIRECTORY: directory,
      },
    );
  } else {
    await new Promise((resolve, reject) => {
      const daemon = spawn("gnome-keyring-daemon", ["--unlock", "--components=secrets"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      daemon.stdout.on("data", (chunk) => {
        output += chunk;
      });
      daemon.stderr.resume();
      daemon.on("error", reject);
      daemon.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("无法启动临时密钥环"));
          return;
        }
        for (const match of output.matchAll(/^(GNOME_KEYRING_CONTROL)=([^;\r\n]+)/gm))
          process.env[match[1]] = match[2];
        resolve();
      });
      daemon.stdin.end(password + "\n");
    });
    await verify();
  }
} finally {
  for (const instance of hosts) await instance.close();
  if (created) {
    if (oldDefault) await security(["default-keychain", "-d", "user", "-s", oldDefault]);
    if (oldSearch) await security(["list-keychains", "-d", "user", "-s", ...oldSearch]);
    await security(["delete-keychain", keychain]);
  }
  if (!process.argv.includes("--session")) await rm(directory, { recursive: true, force: true });
}
