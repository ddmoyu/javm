import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

export async function verifyHostGlobals(binary) {
  // The cloud fixture cannot exercise Cocoa's CGRect return ABI (Issue #14).
  // macOS uses only this isolated, blank local page and never application data.
  const mode = process.platform === "darwin" ? "window" : "cloud";
  const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-host-"));
  const app = path.join(directory, "安全 ' 空格");
  const probeFile = path.join(directory, "protocol-probe.json");
  const environment = { ...process.env };
  if (mode === "window") {
    const library = path.join(directory, "protocol-probe.dylib");
    await execute(
      "xcrun",
      [
        "clang++",
        "-std=c++17",
        "-dynamiclib",
        "-fvisibility=hidden",
        fileURLToPath(new URL("./cocoa-protocol-probe.cpp", import.meta.url)),
        "-lobjc",
        "-o",
        library,
      ],
      { timeout: 30000 },
    );
    await execute("codesign", ["--force", "--sign", "-", library], { timeout: 10000 });
    environment.DYLD_INSERT_LIBRARIES = library;
    environment.JAVM_PROTOCOL_PROBE_FILE = probeFile;
  }
  await mkdir(path.join(app, ".tmp"), { recursive: true });
  await writeFile(path.join(app, "index.html"), "<!doctype html><title>Safe host fixture</title>");
  await writeFile(
    path.join(app, "neutralino.config.json"),
    JSON.stringify({
      applicationId: "net.ddmoyu.javm.hostfixture",
      defaultMode: mode,
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
      nativeAllowList: [
        "app.exit",
        "window.getSize",
        "window.getPosition",
        "window.setSize",
        "window.move",
        "window.center",
      ],
      modes: {
        window: {
          title: "Safe window geometry fixture",
          width: 640,
          height: 480,
          hidden: false,
          center: false,
          useSavedState: false,
          enableInspector: false,
          injectClientLibrary: false,
        },
      },
      logging: { enabled: false },
    }),
  );
  const child = spawn(
    binary,
    [`--mode=${mode}`, "--res-mode=directory", `--path=${app.replaceAll(path.sep, "/")}`],
    { cwd: app, env: environment, windowsHide: true, stdio: "ignore" },
  );
  const exited = once(child, "exit");
  let socket, protocolConformance;
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
      const timer = setTimeout(() => finish(new Error("宿主连接超时")), 10000);
      const opened = () => finish();
      const failed = () => finish(new Error("宿主连接失败"));
      const finish = (error) => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
    const call = (method, data = {}) =>
      new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => finish(new Error(`${method} 响应超时`)), 10000);
        const failed = () => finish(new Error(`${method} 执行期间宿主连接中断`));
        const received = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            assert.equal(message.data.success, true, JSON.stringify(message.data.error));
            finish(null, message.data.returnValue);
          } catch (error) {
            finish(error);
          }
        };
        const finish = (error, value) => {
          clearTimeout(timer);
          socket.removeEventListener("message", received);
          socket.removeEventListener("close", failed);
          socket.removeEventListener("error", failed);
          if (error) reject(error);
          else resolve(value);
        };
        socket.addEventListener("message", received);
        socket.addEventListener("close", failed);
        socket.addEventListener("error", failed);
        try {
          socket.send(JSON.stringify({ id, method, accessToken: auth.nlToken, data }));
        } catch (error) {
          finish(error);
        }
      });
    if (mode === "window") {
      const size = await call("window.getSize");
      assert.equal(size.width, 640);
      assert.equal(size.height, 480);
      const position = await call("window.getPosition");
      assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
      const moved = { x: position.x + 16, y: position.y + 16 };
      await call("window.move", moved);
      assert.deepEqual(await call("window.getPosition"), moved);
      await call("window.center");
      const centered = await call("window.getPosition");
      assert.ok(Number.isFinite(centered.x) && Number.isFinite(centered.y));
      assert.deepEqual(await call("window.getSize"), size);
      await call("window.setSize", { width: 720, height: 512 });
      const resized = await call("window.getSize");
      assert.equal(resized.width, 720);
      assert.equal(resized.height, 512);
      for (let i = 0; i < 200; ++i) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Cocoa 协议查询期间宿主退出");
        try {
          protocolConformance = JSON.parse(await readFile(probeFile, "utf8"));
          break;
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        await delay(50);
      }
      assert.ok(protocolConformance, "Cocoa 协议探针未返回结果");
      assert.equal(protocolConformance.ok, true, protocolConformance.reason);
      assert.equal(protocolConformance.classes, 3);
      assert.ok(protocolConformance.conformanceQueries >= 4);
      // Keep the safe visible window alive across display/Touch Bar update cycles.
      await delay(500);
    }
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
    const verification = {
      mode,
      globals: true,
      windowGeometry: mode === "window",
      ...(mode === "window"
        ? { methods: ["getSize", "getPosition", "move", "center", "setSize"], protocolConformance }
        : {}),
    };
    console.log(`安全宿主验证通过：${JSON.stringify(verification)}`);
    return verification;
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
