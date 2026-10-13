import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";

export async function verifyHostGlobals(binary) {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-host-"));
  const app = path.join(directory, "安全 ' 空格");
  await mkdir(path.join(app, ".tmp"), { recursive: true });
  await writeFile(path.join(app, "index.html"), "<!doctype html><title>Safe host fixture</title>");
  await writeFile(
    path.join(app, "neutralino.config.json"),
    JSON.stringify({
      applicationId: "net.ddmoyu.javm.hostfixture",
      defaultMode: "cloud",
      url: "/",
      documentRoot: "/",
      port: 0,
      enableServer: true,
      enableNativeAPI: true,
      enableExtensions: false,
      exportAuthInfo: true,
      tokenSecurity: "one-time",
      dataLocation: "app",
      storageLocation: "app",
      nativeAllowList: ["app.exit"],
      logging: { enabled: false },
    }),
  );
  const child = spawn(
    binary,
    ["--mode=cloud", "--res-mode=directory", `--path=${app.replaceAll(path.sep, "/")}`],
    { cwd: app, windowsHide: true, stdio: "ignore" },
  );
  const exited = once(child, "exit");
  let socket;
  try {
    let auth;
    for (let i = 0; i < 200; ++i) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("官方宿主启动失败");
      try {
        auth = JSON.parse(await readFile(path.join(app, ".tmp/auth_info.json"), "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await delay(50);
    }
    assert.ok(auth, "宿主未导出认证");
    const source = await fetch(`http://127.0.0.1:${auth.nlPort}/__neutralino_globals.js`, {
      signal: AbortSignal.timeout(5000),
    }).then((response) => {
      assert.equal(response.status, 200);
      return response.text();
    });
    const context = {};
    try {
      vm.runInNewContext(source, context, { timeout: 200 });
    } catch {
      throw new Error("宿主未正确转义路径中的引号，无法初始化前端");
    }
    assert.equal(context.NL_PATH, app.replaceAll(path.sep, "/"));
    assert.equal(context.NL_DATAPATH, app.replaceAll(path.sep, "/"));
    assert.ok(typeof context.NL_TOKEN === "string");
    socket = new WebSocket(
      `ws://127.0.0.1:${auth.nlPort}/?connectToken=${encodeURIComponent(auth.nlConnectToken)}`,
    );
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        method: "app.exit",
        accessToken: auth.nlToken,
        data: { code: 0 },
      }),
    );
    const result = await Promise.race([
      exited,
      delay(10000).then(() => {
        throw new Error("宿主退出超时");
      }),
    ]);
    assert.equal(result[0], 0);
  } finally {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    assert.match(path.basename(directory), /^javm-safe-host-/);
    await rm(directory, { recursive: true, force: true });
  }
}
