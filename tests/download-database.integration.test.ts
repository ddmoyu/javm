import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import type { DownloadTask } from "../frontend/src/contracts/downloads";

// This test peer implements only the official Extension bootstrap/event envelope.
// The production C++ executable and SQLite file are real, with isolated test paths.
interface Connection {
  sendUTF(text: string): void;
  close(): void;
  on(event: "message", handler: (message: { utf8Data: string }) => void): void;
}
interface SocketServer {
  on(
    event: "request",
    handler: (request: { resource: string; accept(): Connection }) => void,
  ): void;
  shutDown(): void;
}
const require = createRequire(import.meta.url);
const neuRequire = createRequire(require.resolve("@neutralinojs/neu/package.json"));
const websocket = neuRequire("websocket") as {
  server: new (options: { httpServer: ReturnType<typeof createServer> }) => SocketServer;
};
const project = fileURLToPath(new URL("../", import.meta.url));
class ExtensionPeer {
  server = createServer();
  socket = new websocket.server({ httpServer: this.server });
  connection?: Connection;
  child?: ChildProcessWithoutNullStreams;
  pending = new Map<string, (reply: { ok: boolean; result: unknown; error?: string }) => void>();
  closed = false;
  async start(database: string) {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Extension connection timeout")), 10000);
      this.socket.on("request", (request) => {
        // Neutralino extracts URL-safe tokens directly; it does not percent-decode them.
        if (!request.resource.includes("connectToken=test_under-score.token")) {
          clearTimeout(timeout);
          reject(new Error("Extension changed the URL-safe connection token"));
          return;
        }
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
        clearTimeout(timeout);
        resolve();
      });
      this.child = spawn(path.join(project, "bin/javm_database.exe"), ["--database", database], {
        windowsHide: true,
      });
      this.child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once("exit", (code) => {
        clearTimeout(timeout);
        if (!this.connection) reject(new Error(`Extension exited ${code}`));
      });
      this.child.stdin.end(
        JSON.stringify({
          nlPort: String(address.port),
          nlToken: "test",
          nlConnectToken: "test_under-score.token",
          nlExtensionId: "net.ddmoyu.javm.database",
        }),
      );
    });
  }
  request<T>(method: string, params: unknown = {}): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Extension request timeout"));
      }, 10000);
      this.pending.set(requestId, (reply) => {
        clearTimeout(timeout);
        this.pending.delete(requestId);
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
    if (this.closed) return;
    this.closed = true;
    this.connection?.close();
    this.socket.shutDown();
    this.server.close();
    const child = this.child;
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill();
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
  }
}
const enabled = process.platform === "win32" && process.env.JAVM_DOWNLOAD_INTEGRATION === "1";
describe.runIf(enabled)("real download SQLite extension", () => {
  let root: string;
  const peers: ExtensionPeer[] = [];
  beforeAll(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/download-db-"));
  });
  afterAll(async () => {
    for (const peer of peers) await peer.close();
  });
  const connect = async (file: string) => {
    const peer = new ExtensionPeer();
    peers.push(peer);
    await peer.start(file);
    return peer;
  };
  it("persists tasks/settings, rejects stale revisions and restores after reconnect", async () => {
    const file = path.join(root, "downloads.sqlite3");
    let peer = await connect(file);
    expect(await peer.request("hello")).toEqual({ protocol: 1, schema: 1 });
    const task = {
      ...createDownloadTasks(
        { urls: ["https://example.com/a.mp4"], directory: root, kind: "auto", headers: {} },
        [],
      )[0]!,
      revision: 1,
    };
    await peer.request("downloads.save", { task, expectedRevision: 0 });
    await peer.request("downloads.settings", { directory: root, concurrency: 2 });
    const revised = { ...task, revision: 2, status: "paused" };
    await peer.request("downloads.save", { task: revised, expectedRevision: 1 });
    await expect(
      peer.request("downloads.save", {
        task: { ...revised, status: "completed" },
        expectedRevision: 1,
      }),
    ).rejects.toThrow("revision conflict");
    await peer.close();
    peer = await connect(file);
    const saved = await peer.request<{ tasks: DownloadTask[]; settings: { concurrency: number } }>(
      "downloads.load",
    );
    expect(saved.tasks).toEqual([revised]);
    expect(saved.settings.concurrency).toBe(2);
    await peer.request("downloads.remove", { id: task.id, revision: 2 });
    expect((await peer.request<{ tasks: DownloadTask[] }>("downloads.load")).tasks).toEqual([]);
  }, 20000);
  it("refuses a second owner so two windows cannot run the same task", async () => {
    const file = path.join(root, "owned.sqlite3");
    const first = await connect(file);
    await first.request("hello");
    const second = await connect(file);
    await expect(second.request("hello")).rejects.toThrow("另一 JAVM 实例");
    expect(await first.request("hello")).toEqual({ protocol: 1, schema: 1 });
  }, 20000);
  it("preserves an unrelated database instead of rebuilding or migrating it", async () => {
    const file = path.join(root, "legacy.sqlite3");
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('do not change'); PRAGMA user_version=17;",
    );
    db.close();
    const before = await fs.readFile(file);
    const peer = await connect(file);
    await expect(peer.request("hello")).rejects.toThrow("existing file has been preserved");
    await peer.close();
    expect(await fs.readFile(file)).toEqual(before);
  }, 20000);
});
