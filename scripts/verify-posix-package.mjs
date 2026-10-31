import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { json, root, run, sha256, target, targets } from "./third-party/posix/common.mjs";
import { verifyHostGlobals } from "./third-party/posix/verify-host.mjs";

if (!targets.includes(target)) throw new Error("安装验证需要相应 POSIX 系统");
const state = await json(path.join(root, `build/posix-package-${target}.json`));
const manifest = await json(state.manifest);
assert.equal(manifest.platform, target);
const installationOnly = process.argv.includes("--installation-only");
if (installationOnly) assert.equal(process.env.GITHUB_ACTIONS, "true");
const desktop = installationOnly
  ? null
  : await json(path.join(root, `build/desktop-verification-${target}.json`));
if (desktop) {
  assert.equal(desktop.platform, target);
  assert.equal(desktop.sourceCommit, manifest.sourceCommit);
  assert.equal(desktop.gui, true);
  assert.equal(desktop.reports.length, 2);
  assert.ok(
    desktop.reports.every((report) => report.done && !report.fatal && !report.errors.length),
  );
}
for (const asset of manifest.assets) {
  assert.equal(path.basename(asset.name), asset.name);
  const file = path.join(state.release, asset.name);
  assert.equal((await stat(file)).size, asset.bytes);
  assert.equal(sha256(await readFile(file)), asset.sha256);
}
const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-install-"));
const home = path.join(directory, "用户 目录");
const data =
  process.platform === "darwin"
    ? path.join(home, "Library/Application Support")
    : path.join(home, ".local/share");
const authFile = path.join(data, "net.ddmoyu.javm.dev/.tmp/auth_info.json");
const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: data,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
};
const completed = [];
const windowGeometry = [];
async function until(read, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error("安装后安全启动检查超时");
}
async function launch(binary, args, reuse = false) {
  await mkdir(path.dirname(authFile), { recursive: true });
  await rm(authFile, { force: true });
  const child = spawn(binary, [...args, "--mode=cloud", "--export-auth-info"], {
    env,
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "",
    socket;
  child.stdout.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4000);
  });
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4000);
  });
  const exit = once(child, "exit");
  const pending = new Map(),
    replies = new Map();
  try {
    const auth = await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`宿主提前退出: ${diagnostics}`);
      try {
        return JSON.parse(await readFile(authFile, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    });
    const accessToken = auth.nlToken ?? auth.accessToken;
    const connectToken = auth.nlConnectToken ?? accessToken.split(".")[1];
    socket = new WebSocket(
      `ws://127.0.0.1:${auth.nlPort ?? auth.port}/?connectToken=${encodeURIComponent(connectToken)}`,
    );
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) pending.get(message.id)?.(message.data);
      if (message.event === "javm.database.response")
        replies.get(message.data.requestId)?.(message.data);
    });
    await until(() => socket.readyState === WebSocket.OPEN);
    async function call(method, data = {}) {
      const id = randomUUID();
      let response;
      pending.set(id, (value) => {
        response = value;
      });
      try {
        socket.send(JSON.stringify({ id, method, accessToken, data }));
        await until(() => response);
        assert.equal(response.success, true, JSON.stringify(response.error));
        return response.returnValue ?? response;
      } finally {
        pending.delete(id);
      }
    }
    async function request(method, params = {}) {
      const requestId = randomUUID();
      let response;
      replies.set(requestId, (value) => {
        response = value;
      });
      try {
        await call("extensions.dispatch", {
          extensionId: "net.ddmoyu.javm.database",
          event: "javm.database.request",
          data: { requestId, protocol: 1, method, params },
        });
        await until(() => response);
        assert.equal(response.ok, true, response.error);
        return response.result;
      } finally {
        replies.delete(requestId);
      }
    }
    await until(async () =>
      (await call("extensions.getStats")).connected.includes("net.ddmoyu.javm.database"),
    );
    assert.equal((await request("capabilities")).media, true);
    const settings = { fixture: "安全安装验证", persisted: true };
    if (reuse) assert.deepEqual((await request("downloads.load")).settings, settings);
    await request("downloads.settings", settings);
    assert.deepEqual((await request("downloads.load")).settings, settings);
    const wav = path.join(home, "安全静音.wav");
    const bytes = Buffer.alloc(44 + 16000);
    bytes.write("RIFF");
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(16000, 40);
    await writeFile(wav, bytes);
    const media = await request("media.probe", { id: randomUUID(), path: wav });
    assert.equal(media.durationMs, 1000);
    await request("close");
    await until(
      async () =>
        !(await call("extensions.getStats")).connected.includes("net.ddmoyu.javm.database"),
    );
    socket.send(
      JSON.stringify({ id: randomUUID(), method: "app.exit", accessToken, data: { code: 0 } }),
    );
    const [code, signal] = await Promise.race([
      exit,
      delay(12000).then(() => {
        throw new Error("宿主未完成退出");
      }),
    ]);
    assert.equal(
      code,
      0,
      `${path.basename(binary)} 启动 ${completed.length + 1}: ${code}/${signal} ${diagnostics}`,
    );
    completed.push(path.basename(binary));
  } finally {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exit, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
    }
  }
}
let mounted,
  installed = false;
try {
  const portable = manifest.assets.find((asset) => asset.kind === "portable");
  const extracted = path.join(directory, "解压 便携包");
  await mkdir(extracted);
  const archive = path.join(state.release, portable.name);
  if (process.platform === "darwin") await run("ditto", ["-x", "-k", archive, extracted]);
  else await run("tar", ["-xf", archive, "-C", extracted]);
  const entry = path.join(
    extracted,
    process.platform === "darwin" ? "JAVM.app/Contents/MacOS/JAVM" : "JAVM/JAVM",
  );
  if (process.platform === "darwin") {
    const verification = await verifyHostGlobals(path.join(path.dirname(entry), "JAVM-host"));
    windowGeometry.push({ kind: "portable", ...verification });
  }
  await launch(entry, []);
  await launch(entry, [], true);
  if (process.platform === "darwin") {
    const dmg = manifest.assets.find((asset) => asset.name.endsWith(".dmg"));
    await run("hdiutil", ["verify", path.join(state.release, dmg.name)]);
    mounted = path.join(directory, "挂载 镜像");
    await mkdir(mounted);
    await run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mounted,
      path.join(state.release, dmg.name),
    ]);
    await run("codesign", ["--verify", "--deep", "--strict", path.join(mounted, "JAVM.app")]);
    const installedApp = path.join(directory, "Applications/JAVM.app");
    await run("ditto", [path.join(mounted, "JAVM.app"), installedApp]);
    await run("codesign", ["--verify", "--deep", "--strict", installedApp]);
    const verification = await verifyHostGlobals(
      path.join(installedApp, "Contents/MacOS/JAVM-host"),
    );
    windowGeometry.push({ kind: "dmg", ...verification });
    await launch(path.join(installedApp, "Contents/MacOS/JAVM"), [], true);
    await run("ditto", [path.join(mounted, "JAVM.app"), installedApp]);
    await run("codesign", ["--verify", "--deep", "--strict", installedApp]);
    await launch(path.join(installedApp, "Contents/MacOS/JAVM"), [], true);
    assert.ok(installedApp.startsWith(directory + path.sep));
    await rm(installedApp, { recursive: true });
  } else {
    const appImage = manifest.assets.find((asset) => asset.name.endsWith(".AppImage"));
    await launch(path.join(state.release, appImage.name), ["--appimage-extract-and-run"], true);
    const deb = manifest.assets.find((asset) => asset.name.endsWith(".deb"));
    const file = path.join(state.release, deb.name);
    assert.equal(await run("dpkg-deb", ["-f", file, "Package"], root, true), "javm");
    assert.equal(await run("dpkg-deb", ["-f", file, "Architecture"], root, true), "amd64");
    // 只在临时 CI 虚拟机上实际安装；本地开发不会改变系统安装状态。
    assert.equal(process.env.GITHUB_ACTIONS, "true", "实际 DEB 安装验证只允许在 CI 隔离系统执行");
    await run("sudo", ["apt-get", "install", "-y", file]);
    installed = true;
    await launch("/usr/bin/javm", [], true);
    await run("sudo", ["dpkg", "-i", file]);
    await launch("/usr/bin/javm", [], true);
    await run("sudo", ["dpkg", "--remove", "javm"]);
    installed = false;
  }
  assert.ok(
    (await stat(path.join(data, "JAVM/downloads-v1.sqlite3"))).isFile(),
    "卸载不能删除用户数据",
  );
  const result = {
    platform: target,
    sourceCommit: manifest.sourceCommit,
    completed,
    safeDataOnly: true,
    gui: !installationOnly,
    scope: installationOnly ? "installation-only" : "desktop-and-installation",
    desktop,
    windowGeometry,
    manifestSha256: sha256(await readFile(state.manifest)),
    preservedUserData: true,
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(state.release, "verification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(`${target}: 便携、安装、覆盖安装、退出及卸载保留数据验证通过`);
} finally {
  if (mounted) await run("hdiutil", ["detach", mounted]);
  if (installed) await run("sudo", ["dpkg", "--remove", "javm"]);
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.match(path.basename(directory), /^javm-safe-install-/);
  await rm(directory, { recursive: true, force: true });
}
