import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface Connection {
  sendUTF(text: string): void;
  close(): void;
  on(event: "message", handler: (message: { utf8Data: string }) => void): void;
}
interface SocketServer {
  on(event: "request", handler: (request: { accept(): Connection }) => void): void;
  shutDown(): void;
}
const require = createRequire(import.meta.url);
const neuRequire = createRequire(require.resolve("@neutralinojs/neu/package.json"));
const websocket = neuRequire("websocket") as {
  server: new (options: {
    httpServer: ReturnType<typeof createServer>;
    maxReceivedFrameSize: number;
    maxReceivedMessageSize: number;
  }) => SocketServer;
};
const project = fileURLToPath(new URL("../../", import.meta.url));

// 仅用于隔离测试，复现官方 Extension 事件信封，不是应用运行时服务器。
export class MediaHost {
  private server = createServer();
  private socket = new websocket.server({
    httpServer: this.server,
    maxReceivedFrameSize: 4 * 1024 * 1024,
    maxReceivedMessageSize: 4 * 1024 * 1024,
  });
  private connection?: Connection;
  private process?: ChildProcessWithoutNullStreams;
  private failure = "";
  private pending = new Map<
    string,
    (reply: { ok: boolean; result: unknown; error?: string }) => void
  >();
  async start(database: string) {
    let connected!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("测试扩展启动超时")), 10000);
      connected = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.socket.on("request", (request) => {
      this.connection = request.accept();
      this.connection.on("message", (message) => {
        const envelope = JSON.parse(message.utf8Data) as {
          method: string;
          data: { data: { requestId: string; ok: boolean; result: unknown; error?: string } };
        };
        if (envelope.method === "app.broadcast") {
          const reply = envelope.data.data;
          this.pending.get(reply.requestId)?.(reply);
        }
      });
      connected();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    this.process = spawn(
      process.env.JAVM_DATABASE_EXE || path.join(project, "bin/javm_database.exe"),
      ["--database", database],
      {
        windowsHide: true,
      },
    );
    let diagnostic = "";
    this.process.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-16000);
    });
    this.process.stdout.resume();
    this.process.once("exit", (code, signal) => {
      this.failure = `测试扩展已退出 (${code ?? signal}): ${diagnostic}`;
      for (const complete of [...this.pending.values()])
        complete({ ok: false, result: null, error: this.failure });
    });
    this.process.stdin.end(
      JSON.stringify({
        nlPort: String(address.port),
        nlToken: "test-token",
        nlConnectToken: "test-connect",
        nlExtensionId: "net.ddmoyu.javm.database",
      }),
    );
    await ready;
  }
  request<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("测试请求超时"));
      }, 20000);
      this.pending.set(requestId, (reply) => {
        this.pending.delete(requestId);
        clearTimeout(timer);
        if (reply.ok) resolve(reply.result as T);
        else reject(new Error(reply.error));
      });
      this.connection!.sendUTF(
        JSON.stringify({
          event: "javm.database.request",
          data: { requestId, protocol: 1, method, params },
        }),
      );
    });
  }
  async close() {
    const child = this.process;
    this.connection?.close();
    this.socket.shutDown();
    this.server.close();
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
}
