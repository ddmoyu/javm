import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";

const require = createRequire(import.meta.url);
const neuRequire = createRequire(require.resolve("@neutralinojs/neu/package.json"));
const websocket = neuRequire("websocket");
const binary = process.env.JAVM_CORE_EXE && path.resolve(process.env.JAVM_CORE_EXE);
const transport =
  process.env.JAVM_CORE_TRANSPORT ?? (process.platform === "win32" ? "winhttp" : "curl");
if (binary) {
  assert.match(path.basename(binary), /^javm_database_core(?:\.exe)?$/);
  assert.ok(existsSync(binary), "先运行 pnpm native:build --core-only");
}
const token = "safe-fixture-token";
const extensionId = "safe.extension 空格+&";
const connectToken = "safe-connect +&=%测试";

async function within(promise, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("安全夹具等待超时")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// 隔离的官方 Extension 宿主模拟，仅使用安全合成数据与回环地址。
class CoreHost {
  server = createServer();
  socket = new websocket.server({
    httpServer: this.server,
    keepalive: false,
    fragmentationThreshold: 29, // 故意在 UTF-8 字符中间分帧。
    maxReceivedFrameSize: 4 * 1024 * 1024,
    maxReceivedMessageSize: 4 * 1024 * 1024,
  });
  pending = new Map();
  ids = new Set();
  diagnostic = "";
  constructor(database, options = {}) {
    this.database = database;
    this.options = options;
  }
  async start() {
    const connected = new Promise((resolve, reject) => {
      this.socket.on("request", (request) => {
        try {
          const query = new URL(request.httpRequest.url, "http://127.0.0.1").searchParams;
          assert.equal(query.get("extensionId"), extensionId);
          assert.equal(query.get("connectToken"), connectToken);
          this.connection = request.accept();
          this.connection.on("error", () => {});
          if (this.options.ignorePing) this.connection.on("ping", (cancel) => cancel());
          this.connection.on("message", (message) => {
            try {
              assert.equal(message.type, "utf8");
              const envelope = JSON.parse(message.utf8Data);
              assert.match(
                envelope.id,
                /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
              );
              assert.ok(!this.ids.has(envelope.id));
              this.ids.add(envelope.id);
              assert.equal(envelope.accessToken, token);
              assert.equal(envelope.method, "app.broadcast");
              assert.equal(envelope.data.event, "javm.database.response");
              const reply = envelope.data.data;
              this.pending.get(reply.requestId)?.resolve(reply);
              this.pending.delete(reply.requestId);
            } catch (error) {
              this.fail(error);
            }
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.child = spawn(binary, ["--database", this.database], { windowsHide: true });
    this.child.stdout.resume();
    this.child.stderr.on("data", (chunk) => {
      this.diagnostic = (this.diagnostic + chunk).slice(-16000);
    });
    this.exit = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => {
        this.fail(new Error(`核心扩展退出 (${code ?? signal}): ${this.diagnostic}`));
        resolve({ code, signal });
      });
    });
    this.child.stdin.on("error", () => {});
    this.child.stdin.end(
      JSON.stringify({
        nlPort: String(this.server.address().port),
        nlToken: token,
        nlExtensionId: extensionId,
        nlConnectToken: connectToken,
      }),
    );
    await within(
      Promise.race([
        connected,
        this.exit.then(() => {
          throw new Error(this.diagnostic || "启动前退出");
        }),
      ]),
    );
  }
  fail(error) {
    this.failure = error;
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  async reply(method, params = {}, protocol = 1) {
    if (this.failure) throw this.failure;
    const requestId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.connection.sendUTF(
      JSON.stringify({
        event: "javm.database.request",
        data: { requestId, protocol, method, params },
      }),
    );
    try {
      return await within(promise);
    } finally {
      this.pending.delete(requestId);
    }
  }
  async request(method, params = {}) {
    const reply = await this.reply(method, params);
    assert.equal(reply.ok, true, reply.error);
    return reply.result;
  }
  async close() {
    this.connection?.close();
    this.socket.shutDown();
    this.server.close();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        await within(this.exit, 3000);
      } catch {
        this.child.kill();
        await within(this.exit);
      }
    }
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-core-safe-"));
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("javm-core-safe-"));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    database: path.join(directory, "安全 数据 🎬.sqlite3"),
    async host(options = {}, database = path.join(directory, "安全 数据 🎬.sqlite3")) {
      const host = new CoreHost(database, options);
      hosts.push(host);
      await host.start();
      return host;
    },
  };
}

describe("隔离数据库与 HTTP 核心", { skip: !binary, timeout: 30000 }, () => {
  test("官方认证、能力声明与分帧中文读写，关闭后仍可恢复", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    assert.deepEqual(await host.request("capabilities"), {
      protocol: 1,
      database: true,
      http: true,
      media: false,
      transport,
    });
    assert.equal(existsSync(f.database), false);
    assert.equal((await host.reply("media.probe", { path: "安全占位" })).ok, false);
    assert.equal((await host.reply("library.status")).ok, false);
    assert.equal(existsSync(f.database), false);
    for (const text of [
      "not json",
      "[]",
      "null",
      '{"event":1}',
      '{"event":"javm.database.request","data":null}',
      '{"event":"javm.database.request","data":{"requestId":3}}',
    ])
      host.connection.sendUTF(text);
    assert.equal((await host.reply("hello", {}, 999)).ok, false);
    assert.deepEqual(await host.request("hello"), { protocol: 1, schema: 2 });
    const task = { id: "safe-task", revision: 1, title: "安全样例 🌿 ".repeat(150), createdAt: 1 };
    await host.request("downloads.save", { task, expectedRevision: 0 });
    assert.deepEqual((await host.request("downloads.load")).tasks, [task]);
    await host.request("close");
    assert.equal((await within(host.exit)).code, 0);
    const reopened = await f.host();
    assert.deepEqual((await reopened.request("downloads.load")).tasks, [task]);
  });

  test("数据库独占锁覆盖多实例，释放后允许重试且不丢记录", async (t) => {
    const f = await fixture(t);
    const first = await f.host();
    await first.request("downloads.settings", { fixture: "保留" });
    const second = await f.host();
    const rejected = await second.reply("hello");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /占用/);
    await first.request("close");
    await within(first.exit);
    assert.deepEqual((await second.request("downloads.load")).settings, { fixture: "保留" });
  });

  test("合成旧版本数据库迁移保留 Unicode 备份及原内容", async (t) => {
    const f = await fixture(t);
    const old = new DatabaseSync(f.database);
    try {
      old.exec(
        "CREATE TABLE download_tasks(id TEXT PRIMARY KEY,revision INTEGER,payload TEXT); CREATE TABLE download_settings(id INTEGER PRIMARY KEY,payload TEXT); PRAGMA application_id=1245793604; PRAGMA user_version=1;",
      );
      old
        .prepare("INSERT INTO download_settings VALUES(1,?)")
        .run(JSON.stringify({ fixture: "旧安全记录" }));
    } finally {
      old.close();
    }
    const host = await f.host();
    assert.deepEqual((await host.request("downloads.load")).settings, { fixture: "旧安全记录" });
    await host.request("close");
    await within(host.exit);
    const backups = (await readdir(f.directory)).filter(
      (name) => name.startsWith(path.basename(f.database) + ".pre-v2-") && name.endsWith(".bak"),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(f.directory, backups[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 1);
      assert.deepEqual(
        JSON.parse(backup.prepare("SELECT payload FROM download_settings").get().payload),
        { fixture: "旧安全记录" },
      );
    } finally {
      backup.close();
    }
  });

  test("大消息发送和数据库分页完整，不在分帧中插入控制字节", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    // 三条记录超过一页字节上限；回包超过单次发送缓冲区。
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: `safe-${i}`,
      revision: 1,
      createdAt: i,
      title: "safe ".repeat(80000),
    }));
    // 大请求按 16 KiB 分帧，避免制造数万帧拖慢测试自身。
    host.connection.config.fragmentationThreshold = 16384;
    for (const task of tasks) await host.request("downloads.save", { task, expectedRevision: 0 });
    const first = await host.request("downloads.load");
    assert.deepEqual(first.tasks, tasks.slice(0, 2));
    const next = await host.request("downloads.load", { offset: first.nextOffset });
    assert.deepEqual(next.tasks, tasks.slice(2));
    assert.equal(next.nextOffset, null);
  });

  test("HTTP 回环、并发响应、取消和超时均走同一官方通信连接", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    const service = createServer((req, res) => {
      if (req.url === "/slow") {
        res.writeHead(200);
        res.write("safe pending");
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("safe fixture 🌿");
      }
    });
    t.after(() => {
      service.closeAllConnections();
      service.close();
    });
    await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${service.address().port}`;
    const params = (name, url, timeoutMs = 2000) => ({
      id: randomUUID(),
      url: base + url,
      output: path.join(f.directory, name),
      maxBytes: 1024,
      timeoutMs,
      connectTimeoutMs: 500,
    });
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        host.request("http.request", params(`安全 ${i}.txt`, "/ok")),
      ),
    );
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.exitCode, 0);
    }
    assert.equal(await readFile(path.join(f.directory, "安全 0.txt"), "utf8"), "safe fixture 🌿");
    const slow = params("cancel.txt", "/slow", 10000);
    const arrived = once(service, "request");
    const pending = host.request("http.request", slow);
    await within(arrived);
    assert.equal((await host.request("capabilities")).http, true);
    assert.deepEqual(await host.request("http.cancel", { id: slow.id }), { stopped: true });
    assert.notEqual((await pending).exitCode, 0);
    assert.equal(
      (await host.request("http.request", params("timeout.txt", "/slow", 500))).exitCode,
      28,
    );
    assert.equal(existsSync(f.database), false);
  });

  test("未打开数据库即可关闭，不能产生空数据库", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    await host.request("close");
    assert.equal((await within(host.exit)).code, 0);
    assert.equal(existsSync(f.database), false);
  });

  test("空闲连接回应宿主 Ping，控制帧不进入业务解析", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    const pong = once(host.connection, "pong");
    host.connection.ping("safe-ping");
    assert.equal((await within(pong, 2000))[0].toString(), "safe-ping");
    assert.equal((await host.request("capabilities")).transport, transport);
  });

  test("HTTP 仍在读取时显式关闭会停止传输并释放输出文件", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    const service = createServer((_, res) => {
      res.writeHead(200);
      res.write("safe pending");
    });
    t.after(() => {
      service.closeAllConnections();
      service.close();
    });
    await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
    const arrived = once(service, "request");
    const output = path.join(f.directory, "关闭中的安全文件.txt");
    const pending = host.request("http.request", {
      id: randomUUID(),
      url: `http://127.0.0.1:${service.address().port}`,
      output,
      maxBytes: 1024,
      timeoutMs: 120000,
    });
    // 关闭会中止尚未返回的请求，必须先注册拒绝处理。
    const rejected = assert.rejects(pending, /退出/);
    await within(arrived);
    await host.request("close");
    assert.equal((await within(host.exit, 4000)).code, 0);
    await rejected;
    await rm(output);
    assert.equal(existsSync(f.database), false);
  });

  test("宿主套接字异常断开后自动退出并释放数据库锁", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    await host.request("hello");
    host.connection.drop(1006, "safe fixture disconnect", true);
    await within(host.exit, 6000);
    const restarted = await f.host();
    assert.equal((await restarted.request("hello")).schema, 2);
  });

  test(
    "无 Pong 的僵死宿主连接在有界时间内退出",
    { skip: transport !== "curl", timeout: 18000 },
    async (t) => {
      const f = await fixture(t);
      const host = await f.host({ ignorePing: true });
      await host.request("hello");
      await within(host.exit, 14000);
      const restarted = await f.host();
      assert.equal((await restarted.request("hello")).schema, 2);
    },
  );

  test(
    "数据库忙等待期间断连也能有界退出，已提交内容保留",
    { skip: transport !== "curl" },
    async (t) => {
      const f = await fixture(t);
      const host = await f.host();
      await host.request("downloads.settings", { fixture: "已提交" });
      const blocker = new DatabaseSync(f.database);
      try {
        blocker.exec("BEGIN IMMEDIATE");
        const pending = assert.rejects(
          host.request("downloads.settings", { fixture: "未提交" }),
          /退出/,
        );
        await delay(200);
        host.connection.drop(1006, "safe busy disconnect", true);
        assert.equal((await within(host.exit, 4000)).code, 1);
        await pending;
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
      const restarted = await f.host();
      assert.deepEqual((await restarted.request("downloads.load")).settings, { fixture: "已提交" });
    },
  );

  for (const kind of ["binary", "oversized"]) {
    test(`拒绝 ${kind} 消息并退出，保留未打开数据库状态`, async (t) => {
      const f = await fixture(t);
      const host = await f.host();
      host.connection.config.fragmentOutgoingMessages = false;
      if (kind === "binary") host.connection.sendBytes(Buffer.from("safe"));
      else host.connection.sendUTF("x".repeat(4 * 1024 * 1024 + 1));
      await within(host.exit, 6000);
      assert.equal(existsSync(f.database), false);
    });
  }

  test("启动信封校验端口、字段和大小且不输出令牌", async (t) => {
    const f = await fixture(t);
    const valid = {
      nlPort: 1,
      nlToken: token,
      nlConnectToken: connectToken,
      nlExtensionId: extensionId,
    };
    const inputs = [
      "null",
      JSON.stringify({ ...valid, nlPort: "1junk" }),
      JSON.stringify({ ...valid, nlPort: 65536 }),
      JSON.stringify({ ...valid, nlPort: 0 }),
      JSON.stringify({ ...valid, nlToken: "\nsecret" }),
      "x".repeat(65537),
    ];
    for (const input of inputs) {
      const child = spawn(binary, ["--database", f.database], { windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const closed = once(child, "close");
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      try {
        assert.notEqual((await within(closed))[0], 0);
      } finally {
        if (child.exitCode === null) child.kill();
      }
      assert.ok(!output.includes(token));
      assert.ok(!output.includes(connectToken));
    }
    assert.equal(existsSync(f.database), false);
  });
});
