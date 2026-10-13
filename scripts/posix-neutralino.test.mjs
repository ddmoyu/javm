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

const binary = process.env.JAVM_PROCESS_EXE && path.resolve(process.env.JAVM_PROCESS_EXE);
const hostBinary = process.env.JAVM_NEUTRALINO_EXE && path.resolve(process.env.JAVM_NEUTRALINO_EXE);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function until(read, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(30);
  }
  throw new Error("Official POSIX process fixture timed out");
}

// 真正调用官方 spawnProcess / chmod / access / stdInEnd；cloud 模式无窗口、无用户数据。
test(
  "官方 POSIX 宿主通过进程事件转发输出并确认进程组取消",
  {
    skip: !binary || !hostBinary || !["linux", "darwin"].includes(process.platform),
    timeout: 20000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "javm-posix-host-safe-"));
    let host, socket;
    t.after(async () => {
      socket?.close();
      if (host && host.exitCode === null && host.signalCode === null) {
        const end = once(host, "exit");
        host.kill("SIGKILL");
        await end;
      }
      // 若用例中途失败，给监督器的宿主退出监护和 TERM/KILL 回收留出时间。
      await delay(1600);
      assert.equal(path.dirname(root), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith("javm-posix-host-safe-"));
      await rm(root, { recursive: true, force: true });
    });
    const hostPath = path.join(root, desktopHostFile());
    const supervisor = path.join(root, "监督器 ' 空格");
    await copyFile(hostBinary, hostPath);
    await copyFile(binary, supervisor);
    await chmod(hostPath, 0o755);
    await chmod(supervisor, 0o755);
    await mkdir(path.join(root, ".tmp"));
    await mkdir(path.join(root, "public"));
    await writeFile(
      path.join(root, "public/index.html"),
      "<!doctype html><title>Safe process fixture</title>",
    );
    await writeFile(
      path.join(root, "neutralino.config.json"),
      JSON.stringify({
        applicationId: "net.ddmoyu.javm.processfixture",
        version: "0.0.0",
        defaultMode: "cloud",
        url: "/",
        documentRoot: "/public/",
        port: 0,
        enableServer: true,
        enableNativeAPI: true,
        exportAuthInfo: true,
        tokenSecurity: "one-time",
        dataLocation: "app",
        storageLocation: "app",
        logging: { enabled: false },
        nativeAllowList: [
          "app.exit",
          "os.spawnProcess",
          "os.getSpawnedProcesses",
          "os.updateSpawnedProcess",
          "filesystem.chmod",
          "filesystem.access",
        ],
      }),
    );
    host = spawn(hostPath, ["--mode=cloud", "--res-mode=directory", `--path=${root}`], {
      cwd: root,
      stdio: "ignore",
    });
    const auth = await until(async () => {
      if (host.exitCode !== null)
        throw new Error("Official host exited before fixture authentication");
      try {
        return JSON.parse(await readFile(path.join(root, ".tmp/auth_info.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    });
    const accessToken = auth.nlToken ?? auth.accessToken;
    const connectToken = auth.nlConnectToken ?? accessToken?.split(".")[1];
    socket = new WebSocket(
      `ws://127.0.0.1:${auth.nlPort ?? auth.port}/?connectToken=${encodeURIComponent(connectToken)}`,
    );
    const responses = new Map(),
      events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) responses.set(message.id, message.data);
      if (message.event === "spawnedProcess") events.push(message.data);
    });
    await until(() => socket.readyState === WebSocket.OPEN);
    async function call(method, data = {}) {
      const id = randomUUID();
      socket.send(JSON.stringify({ id, method, data, accessToken }));
      const response = await until(() => responses.get(id));
      responses.delete(id);
      assert.equal(response.success, true, response.error?.code);
      return response.returnValue ?? response;
    }
    const privateDir = path.join(root, "private");
    await mkdir(privateDir);
    await call("filesystem.chmod", { path: privateDir, mode: 0o700 });
    await call("filesystem.access", { path: supervisor, mode: 1 });
    const payload = path.join(privateDir, "process.json");
    const fixture = fileURLToPath(
      new URL("../tests/fixtures/posix-process/tool.mjs", import.meta.url),
    );
    const start = async (mode, args) => {
      await writeFile(
        payload,
        JSON.stringify({
          schema: 1,
          file: process.execPath,
          args: [fixture, mode, path.join(root, "started"), ...args],
        }),
      );
      await call("filesystem.chmod", { path: payload, mode: 0o600 });
      return call("os.spawnProcess", {
        command: `exec ${quote(supervisor)} --owner ${host.pid} --payload ${quote(payload)}`,
      });
    };
    const first = await start("echo", ["中文 $(literal)"]);
    await until(() => events.some((event) => event.id === first.id && event.action === "exit"));
    assert.equal(
      Number(events.find((event) => event.id === first.id && event.action === "exit").data),
      23,
    );
    const output = events
      .filter((event) => event.id === first.id && event.action === "stdOut")
      .map((event) => event.data)
      .join("");
    assert.deepEqual(JSON.parse(output).args, ["中文 $(literal)"]);
    assert.equal(
      events
        .filter((event) => event.id === first.id && event.action === "stdErr")
        .map((event) => event.data)
        .join(""),
      "safe stderr\n",
    );
    const second = await start("tree", []);
    const pids = await until(async () => {
      try {
        return JSON.parse(await readFile(path.join(root, "started"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    });
    await call("os.updateSpawnedProcess", { id: second.id, event: "stdInEnd" });
    await until(
      async () => !(await call("os.getSpawnedProcesses")).some((item) => item.id === second.id),
    );
    await until(() => events.some((event) => event.id === second.id && event.action === "exit"));
    assert.equal(
      Number(events.find((event) => event.id === second.id && event.action === "exit").data),
      130,
    );
    for (const pid of [pids.leader, pids.descendant])
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      });
    const end = once(host, "exit");
    socket.send(
      JSON.stringify({ id: randomUUID(), method: "app.exit", accessToken, data: { code: 0 } }),
    );
    assert.equal((await end)[0], 0);
  },
);
