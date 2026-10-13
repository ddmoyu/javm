import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { desktopHostFile } from "./desktop-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.JAVM_CORE_EXE && path.resolve(process.env.JAVM_CORE_EXE);
const hostBinary = process.env.JAVM_NEUTRALINO_EXE && path.resolve(process.env.JAVM_NEUTRALINO_EXE);
const extensionId = "net.ddmoyu.javm.database";

async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Neutralino 安全夹具等待超时");
}

// 真实官方宿主仅运行 cloud 模式；独立空目录，无窗口、无用户数据、无业务来源。
test(
  "官方 Neutralino 宿主启动核心扩展并完成数据库闭环",
  { skip: !binary || !hostBinary, timeout: 25000 },
  async (t) => {
    assert.match(path.basename(binary), /^javm_database_core(?:\.exe)?$/);
    const directory = await mkdtemp(path.join(tmpdir(), "javm-core-host-safe-"));
    let child, socket;
    t.after(async () => {
      socket?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      // 宿主异常结束时，扩展的独立监护最多约 12 秒完成回收。
      await until(async () => {
        try {
          assert.equal(path.dirname(directory), path.resolve(tmpdir()));
          assert.ok(path.basename(directory).startsWith("javm-core-host-safe-"));
          await rm(directory, { recursive: true, force: true });
          return true;
        } catch (error) {
          if (["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) return false;
          throw error;
        }
      }, 14000);
    });
    const host = path.join(directory, desktopHostFile());
    const core = path.join(directory, path.basename(binary));
    await copyFile(hostBinary, host);
    await copyFile(binary, core);
    if (process.platform !== "win32") {
      await chmod(host, 0o755);
      await chmod(core, 0o755);
    }
    await copyFile(
      path.join(root, "tests/fixtures/core-extension/neutralino.config.json"),
      path.join(directory, "neutralino.config.json"),
    );
    await mkdir(path.join(directory, "public"));
    await mkdir(path.join(directory, ".tmp"));
    await writeFile(
      path.join(directory, "public/index.html"),
      "<!doctype html><title>Safe core fixture</title>",
    );
    child = spawn(host, ["--mode=cloud", "--res-mode=directory", `--path=${directory}`], {
      cwd: directory,
      windowsHide: true,
      stdio: "ignore",
    });
    const exit = once(child, "exit");
    const auth = await until(async () => {
      if (child.exitCode !== null) throw new Error("官方宿主在导出夹具认证前退出");
      try {
        return JSON.parse(await readFile(path.join(directory, ".tmp/auth_info.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    });
    const accessToken = auth.nlToken ?? auth.accessToken;
    const connectToken = auth.nlConnectToken ?? accessToken?.split(".")[1];
    assert.equal(typeof accessToken, "string");
    assert.equal(typeof connectToken, "string");
    socket = new WebSocket(
      `ws://127.0.0.1:${auth.nlPort ?? auth.port}/?connectToken=${encodeURIComponent(connectToken)}`,
    );
    const api = new Map(),
      replies = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) api.get(message.id)?.(message.data);
      if (message.event === "javm.database.response")
        replies.get(message.data.requestId)?.(message.data);
    });
    await until(() => {
      if (socket.readyState === WebSocket.CLOSED) throw new Error("官方宿主拒绝夹具连接");
      return socket.readyState === WebSocket.OPEN;
    });
    async function call(method, data = {}) {
      const id = randomUUID();
      let response;
      api.set(id, (value) => {
        response = value;
      });
      try {
        socket.send(JSON.stringify({ id, method, accessToken, data }));
        await until(() => response);
        assert.equal(response.success, true, response.error?.code);
        return response.returnValue ?? response;
      } finally {
        api.delete(id);
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
          extensionId,
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
    await until(async () => (await call("extensions.getStats")).connected.includes(extensionId));
    const capabilities = await request("capabilities");
    assert.equal(capabilities.media, false);
    assert.equal(
      capabilities.transport,
      process.env.JAVM_CORE_TRANSPORT ?? (process.platform === "win32" ? "winhttp" : "curl"),
    );
    assert.equal((await request("hello")).schema, 2);
    await request("downloads.settings", { fixture: "官方宿主安全样例" });
    assert.deepEqual((await request("downloads.load")).settings, { fixture: "官方宿主安全样例" });
    await request("close");
    await until(async () => !(await call("extensions.getStats")).connected.includes(extensionId));
    // app.exit 可能先关闭连接再返回，不等待其响应。
    socket.send(
      JSON.stringify({ id: randomUUID(), method: "app.exit", accessToken, data: { code: 0 } }),
    );
    const result = await exit;
    assert.equal(result[0], 0);
  },
);
