// 执行 0.5.3 原版 updater 插件，旧业务不启动；新安装包仅通过 cloud 模式验证。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { signLegacyFile, verifyLegacySignature } from "./legacy-update.mjs";
import { hashFile } from "./update-format.mjs";
assert.equal(process.env.GITHUB_ACTIONS, "true", "只允许在一次性 CI 系统中验证旧版安装");
const run = promisify(execFile);
const exec = (file, args, options = {}) =>
  run(file, args, { timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const win = process.platform === "win32",
  mac = process.platform === "darwin";
const target = win
  ? "windows-x64"
  : mac
    ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
    : "linux-x64";
const key = (await json("resources/legacy-update-public-key.json")).publicKey;
const harness = path.resolve(
  "native/update/tests/legacy-tauri/target/debug/javm-legacy-update-fixture" + (win ? ".exe" : ""),
);
await mkdir(".tmp", { recursive: true });
const base = await mkdtemp(path.resolve(".tmp", "legacy-actual-"));
const downloads = path.join(base, "downloads");
await mkdir(downloads);
const newVersion = (await json("package.json")).version;
const release = path.resolve(win ? "build/installer" : `dist/posix-release/${target}`);
async function findAsset(suffix) {
  const names = (await readdir(release)).filter(
    (name) => name.startsWith(`JAVM-${newVersion}-${target}`) && name.endsWith(suffix),
  );
  assert.equal(names.length, 1, `${release}: ${suffix}`);
  return path.join(release, names[0]);
}
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error("旧版升级验收超时");
}
async function launchNew(entry, args = []) {
  const home = path.join(base, "safe-home"),
    data = path.join(
      home,
      win ? "AppData/Roaming" : mac ? "Library/Application Support" : ".local/share",
    );
  const authFile = path.join(data, "net.ddmoyu.javm.dev/.tmp/auth_info.json");
  await mkdir(path.dirname(authFile), { recursive: true });
  await rm(authFile, { force: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: data,
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  const child = spawn(entry, [...args, "--mode=cloud", "--export-auth-info"], {
    cwd: base,
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  let socket;
  try {
    const auth = await until(async () => {
      if (child.exitCode !== null) throw new Error(`新版提前退出: ${child.exitCode}`);
      try {
        return await json(authFile);
      } catch (e) {
        if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
        throw e;
      }
    });
    const token = auth.nlToken ?? auth.accessToken,
      connect = auth.nlConnectToken ?? token.split(".")[1];
    socket = new WebSocket(
      `ws://127.0.0.1:${auth.nlPort ?? auth.port}/?connectToken=${encodeURIComponent(connect)}`,
    );
    const responses = new Map(),
      native = new Map();
    socket.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) responses.set(m.id, m.data);
      if (m.event === "javm.database.response") native.set(m.data.requestId, m.data);
    });
    await until(() => socket.readyState === WebSocket.OPEN);
    const call = async (method, data = {}) => {
      const id = randomUUID();
      socket.send(JSON.stringify({ id, method, data, accessToken: token }));
      const reply = await until(() => responses.get(id));
      assert.equal(reply.success, true, JSON.stringify(reply.error));
      return reply.returnValue ?? reply;
    };
    await until(async () =>
      (await call("extensions.getStats")).connected.includes("net.ddmoyu.javm.database"),
    );
    const requestId = randomUUID();
    await call("extensions.dispatch", {
      extensionId: "net.ddmoyu.javm.database",
      event: "javm.database.request",
      data: { requestId, protocol: 1, method: "capabilities", params: {} },
    });
    assert.equal((await until(() => native.get(requestId))).result.database, true);
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        method: "app.exit",
        data: { code: 0 },
        accessToken: token,
      }),
    );
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill();
  }
}
async function legacyAsset(name) {
  await exec("gh", [
    "release",
    "download",
    "v0.5.3",
    "--repo",
    "ddmoyu/javm",
    "--pattern",
    name,
    "--pattern",
    name + ".sig",
    "--dir",
    downloads,
  ]);
  const file = path.join(downloads, name);
  await verifyLegacySignature(file, (await readFile(file + ".sig", "utf8")).trim(), key);
  return file;
}
const results = [];
let debInstalled = false,
  windowsInstalled = false;
const server = createServer();
let activeAsset,
  signature,
  corrupt = false;
server.on("request", async (req, res) => {
  if (req.url === "/latest.json") {
    const platform = win
      ? "windows-x86_64"
      : mac
        ? `darwin-${process.arch === "arm64" ? "aarch64" : "x86_64"}`
        : "linux-x86_64";
    const entry = { url: `http://127.0.0.1:${server.address().port}/package`, signature };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        version: newVersion,
        notes: "Safe validation",
        platforms: {
          [platform]: entry,
          [platform + "-deb"]: entry,
          [platform + "-appimage"]: entry,
          [platform + "-nsis"]: entry,
          [platform + "-app"]: entry,
        },
      }),
    );
  } else if (req.url === "/package") {
    res.setHeader("Content-Length", (await stat(activeAsset)).size);
    if (corrupt) {
      const bytes = await readFile(activeAsset);
      bytes[bytes.length - 1] ^= 1;
      res.end(bytes);
    } else createReadStream(activeAsset).pipe(res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
async function upgrade(kind, entry, asset, exe = harness) {
  activeAsset = asset;
  signature = await signLegacyFile(asset, key);
  const config = path.join(base, `config-${kind}.json`),
    proof = path.join(base, `proof-${kind}.json`);
  const input = {
    entry,
    publicKey: key,
    endpoint: `http://127.0.0.1:${server.address().port}/latest.json`,
    proof,
  };
  const oldHash = await hashFile(entry);
  corrupt = true;
  await writeFile(config, JSON.stringify({ ...input, reject: true }));
  await exec(exe, [config]);
  assert.equal((await json(proof)).rejected, true);
  assert.equal(await hashFile(entry), oldHash);
  corrupt = false;
  await writeFile(config, JSON.stringify(input));
  await exec(exe, [config]);
  const result = await json(proof);
  assert.equal(result.oldVersion, "0.5.3");
  assert.equal(result.newVersion, newVersion);
  results.push({ kind, ...result, originalAssetVerified: true, tamperRejected: true });
}
try {
  if (mac) {
    const old = await legacyAsset(
      `javm_${process.arch === "arm64" ? "aarch64" : "x64"}.app.tar.gz`,
    );
    const installation = path.join(base, "installed");
    await mkdir(installation);
    await exec("tar", ["-xf", old, "-C", installation]);
    const bundle = (await readdir(installation)).find((x) => x.endsWith(".app"));
    assert.ok(bundle);
    const appPath = path.join(installation, bundle),
      bin = path.join(appPath, "Contents/MacOS");
    const oldEntry = path.join(
      bin,
      (await readdir(bin)).find((x) => x.toLowerCase() === "javm"),
    );
    await upgrade("app", oldEntry, await findAsset("-legacy.app.tar.gz"));
    await exec("codesign", ["--verify", "--deep", "--strict", appPath]);
    await launchNew(path.join(bin, "JAVM"));
  } else if (!win) {
    const oldImage = await legacyAsset("javm_0.5.3_amd64.AppImage");
    const entry = path.join(base, "JAVM.AppImage");
    await copyFile(oldImage, entry);
    await chmod(entry, 0o755);
    await upgrade("appimage", entry, await findAsset(".AppImage"));
    await launchNew(entry, ["--appimage-extract-and-run"]);
    const oldDeb = await legacyAsset("javm_0.5.3_amd64.deb");
    await exec("sudo", ["dpkg", "-i", oldDeb]);
    debInstalled = true;
    const patched = path.join(base, "legacy-deb-fixture"),
      bytes = await readFile(harness);
    const needle = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK"),
      offset = bytes.indexOf(needle);
    assert.ok(offset >= 0, "缺少 Tauri bundler 安装类型标记");
    Buffer.from("__TAURI_BUNDLE_TYPE_VAR_DEB").copy(bytes, offset);
    await writeFile(patched, bytes, { mode: 0o755 });
    await upgrade("deb", "/usr/bin/javm", await findAsset(".deb"), patched);
    assert.equal(
      (await exec("dpkg-query", ["-W", "-f=${Version}", "javm"])).stdout,
      newVersion.replace("-beta.", "~beta."),
    );
    await launchNew("/usr/bin/javm");
  } else {
    const old = await legacyAsset("javm_0.5.3_x64-setup.exe");
    const install = path.join(base, "installed");
    await exec(old, ["/S", `/D=${install}`]);
    windowsInstalled = true;
    await upgrade("setup", path.join(install, "javm.exe"), await findAsset("-setup.exe"));
    await until(async () => {
      try {
        return (await json(path.join(install, "update-installation.json"))).version === newVersion;
      } catch {
        return false;
      }
    }, 90000);
    // ShellExecute 交接后安装器可能尚在写最后几个文件。
    await until(async () => {
      try {
        await exec("reg.exe", [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\javm",
        ]);
        return false;
      } catch {
        return true;
      }
    });
    await launchNew(path.join(install, "JAVM.exe"));
  }
  await mkdir("build", { recursive: true });
  await writeFile(
    `build/legacy-upgrade-${target}.json`,
    JSON.stringify(
      {
        platform: target,
        results,
        newHostStarted: true,
        safeDataOnly: true,
        legacyBusinessStarted: false,
        sourceCommit: process.env.GITHUB_SHA,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${target}: 0.5.3 原更新插件下载、验签、安装交接与新宿主启动通过`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (debInstalled) await exec("sudo", ["dpkg", "--remove", "javm"]);
  if (windowsInstalled) {
    const install = path.join(base, "installed");
    try {
      await exec(path.join(install, "unins000.exe"), [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
      ]);
    } catch {
      await exec(path.join(install, "uninstall.exe"), ["/S"]);
    }
  }
}
