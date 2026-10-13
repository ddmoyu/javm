import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const neuRequire = createRequire(require.resolve("@neutralinojs/neu/package.json"));
const websocket = neuRequire("websocket");
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
export class ExtensionFixture {
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
  constructor(binary, database, options = {}) {
    this.binary = binary;
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
    this.child = spawn(this.binary, ["--database", this.database], {
      windowsHide: true,
      env: this.options.env ?? process.env,
    });
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
      return await within(promise, this.options.requestTimeoutMs ?? 8000);
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
