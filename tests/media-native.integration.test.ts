import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { LibraryStatus, NativeVideo } from "../frontend/src/contracts/library";

// 测试宿主复现 Neutralino 官方 Extension 的握手与事件信封；不引入第二套运行时协议。
interface Connection {
  sendUTF(text: string): void;
  close(): void;
  on(event: "message", handler: (message: { type: string; utf8Data: string }) => void): void;
}
interface SocketServer {
  on(event: "request", handler: (request: { accept(): Connection }) => void): void;
  shutDown(): void;
}
const require = createRequire(import.meta.url);
const neuRequire = createRequire(require.resolve("@neutralinojs/neu/package.json"));
const websocket = neuRequire("websocket") as {
  server: new (options: { httpServer: ReturnType<typeof createServer> }) => SocketServer;
};
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));

class Host {
  server = createServer();
  socket = new websocket.server({ httpServer: this.server });
  connection?: Connection;
  process?: ChildProcessWithoutNullStreams;
  pending = new Map<string, (reply: { ok: boolean; result: unknown; error?: string }) => void>();
  async start(database: string) {
    const connected = new Promise<void>((resolve) =>
      this.socket.on("request", (request) => {
        this.connection = request.accept();
        this.connection.on("message", (message) => {
          const envelope = JSON.parse(message.utf8Data) as {
            method: string;
            data: { data: { requestId: string; ok: boolean; result: unknown; error?: string } };
          };
          if (envelope.method !== "app.broadcast") return;
          const reply = envelope.data.data;
          this.pending.get(reply.requestId)?.(reply);
        });
        resolve();
      }),
    );
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    this.process = spawn(path.join(project, "bin/javm_database.exe"), ["--database", database], {
      windowsHide: true,
    });
    this.process.stdin.end(
      JSON.stringify({
        nlPort: String(address.port),
        nlToken: "test-token",
        nlConnectToken: "test-connect",
        nlExtensionId: "net.ddmoyu.javm.database",
      }),
    );
    await connected;
  }
  request<T>(method: string, params: unknown = {}): Promise<T> {
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
  async finish() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await this.request<LibraryStatus>("library.status");
      if (result.scan?.state !== "scanning") return result;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("扫描测试超时");
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

describe.runIf(enabled)("真实 MediaInfo / pugixml / SQLite / Extension 扫描", () => {
  let root: string;
  let media: string;
  let video: string;
  const hosts: Host[] = [];
  let host: Host;
  let directoryId: string;
  beforeAll(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/media-integration-"));
    media = path.join(root, "中文媒体_%");
    await fs.mkdir(media);
    video = path.join(media, "TEST-001.mp4");
    execFileSync(
      process.env.JAVM_FFMPEG || "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=25",
        "-t",
        "2",
        "-c:v",
        "mpeg4",
        video,
      ],
      { windowsHide: true },
    );
    await fs.writeFile(
      path.join(media, "TEST-001.nfo"),
      "<movie><title>测试 &amp; 标题</title><num>TEST-001</num><uniqueid type='tmdb'>12345</uniqueid><runtime>99</runtime><actor><name>测试演员</name></actor><genre>纪录片</genre><set><name>测试系列</name></set></movie>",
    );
    await fs.writeFile(path.join(media, "code.ts"), "export const notAVideo = true;");
    host = new Host();
    hosts.push(host);
    await host.start(path.join(root, "downloads-v1.sqlite3"));
  });
  afterAll(async () => {
    for (const host of hosts) await host.close();
  });
  it("真实视频流确认、秒数/分辨率、中文路径、NFO 和 TypeScript 排除", async () => {
    const added = await host.request<{ directoryId: string }>("library.add", {
      path: media,
      recursive: true,
      formats: [],
    });
    directoryId = added.directoryId;
    const result = await host.finish();
    expect(result.scan, JSON.stringify(result.scan)).toMatchObject({
      state: "completed",
      imported: 1,
      skipped: 1,
      errors: 0,
    });
    const videos = await host.request<NativeVideo[]>("library.videos");
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      title: "测试 & 标题",
      local_id: "TEST-001",
      duration: 2,
      width: 320,
      height: 180,
      actors: ["测试演员"],
      series: "测试系列",
    });
  });
  it("重复添加同一路径和增量扫描不重复入库", async () => {
    await host.request("library.add", { path: media.toUpperCase(), recursive: true, formats: [] });
    const result = await host.finish();
    expect(result.directories).toHaveLength(1);
    expect(result.scan).toMatchObject({ unchanged: 1, imported: 0 });
    expect(await host.request<NativeVideo[]>("library.videos")).toHaveLength(1);
    await expect(
      host.request("library.add", { path: root, recursive: true, formats: [] }),
    ).rejects.toThrow("重叠");
  });
  it("NFO 修改可更新导入字段，损坏 NFO 保留资料和演员", async () => {
    await fs.writeFile(
      path.join(media, "TEST-001.nfo"),
      "<movie><title>更新标题</title><actor><name>新演员</name></actor></movie>",
    );
    await host.request("library.scan", { id: directoryId });
    await host.finish();
    expect((await host.request<NativeVideo[]>("library.videos"))[0]).toMatchObject({
      title: "更新标题",
      actors: ["新演员"],
    });
    await fs.writeFile(path.join(media, "TEST-001.nfo"), "<movie><title>坏 XML");
    await host.request("library.scan", { id: directoryId });
    expect((await host.finish()).scan?.state).toBe("partial");
    expect((await host.request<NativeVideo[]>("library.videos"))[0]).toMatchObject({
      title: "更新标题",
      actors: ["新演员"],
    });
  });
  it("离线目录保留记录；在线扫描发现丢失只标记，恢复后复用 ID", async () => {
    const first = (await host.request<NativeVideo[]>("library.videos"))[0]!;
    const offline = media + "-offline";
    await fs.rename(media, offline);
    await expect(host.request("library.scan", { id: directoryId })).rejects.toThrow();
    expect((await host.request<NativeVideo[]>("library.videos"))[0]).toMatchObject({
      id: first.id,
      missing: 0,
    });
    await fs.rename(offline, media);
    await fs.rename(video, video + ".hold");
    await host.request("library.scan", { id: directoryId });
    await host.finish();
    expect((await host.request<NativeVideo[]>("library.videos"))[0]).toMatchObject({
      id: first.id,
      missing: 1,
    });
    await fs.rename(video + ".hold", video);
    await host.request("library.scan", { id: directoryId });
    await host.finish();
    expect((await host.request<NativeVideo[]>("library.videos"))[0]).toMatchObject({
      id: first.id,
      missing: 0,
    });
  });
  it("取消保留已提交记录，收藏持久化", async () => {
    const first = (await host.request<NativeVideo[]>("library.videos"))[0]!;
    await host.request("library.favorite", { id: first.id, value: true });
    for (let i = 0; i < 25; ++i) await fs.copyFile(video, path.join(media, `cancel-${i}.mp4`));
    await host.request("library.scan", { id: directoryId });
    await host.request("library.cancel");
    expect((await host.finish()).scan?.state).toBe("cancelled");
    expect(
      (await host.request<NativeVideo[]>("library.videos")).find((item) => item.id === first.id)
        ?.favorite,
    ).toBe(1);
  });
  it("并发按逻辑处理器数减二自动计算，真实探测并行且进度可响应", async () => {
    const system = await host.request<LibraryStatus>("library.status");
    expect(system.defaultConcurrency).toBe(
      Math.max(1, Math.min(16, system.logicalProcessors! - 2)),
    );
    expect(system.maxConcurrency).toBe(16);
    const limit = system.defaultConcurrency!;
    await host.request("library.scan", { id: directoryId });
    const result = await host.finish();
    expect(result.scan).toMatchObject({ state: "partial", concurrency: limit, activeProbes: 0 });
    expect(result.scan!.peakProbes).toBeGreaterThan(0);
    expect(result.scan!.peakProbes).toBeLessThanOrEqual(limit);
    const files = await host.request<NativeVideo[]>("library.videos");
    expect(files).toHaveLength(26);
    await host.request("library.scan", { id: directoryId, concurrency: 1 });
    expect((await host.finish()).scan).toMatchObject({
      concurrency: limit,
      peakProbes: 1, // 伪装成 .ts 的文本每次仍需确认，不保存为影片。
      unchanged: 26,
    });
    await host.request("library.scan", { id: directoryId, concurrency: 17 });
    expect((await host.finish()).scan?.concurrency).toBe(limit);
  });
  it("媒体库数据库写锁阻塞时，进度、取消和下载数据库仍能响应", async () => {
    const lock = new DatabaseSync(path.join(root, "library.sqlite3"));
    const first = (await host.request<NativeVideo[]>("library.videos"))[0]!;
    lock.exec("BEGIN IMMEDIATE");
    const pending = host.request("library.favorite", { id: first.id, value: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const started = Date.now();
      const replies = await Promise.all([
        host.request("library.status"),
        host.request("library.cancel"),
        host.request("downloads.load"),
      ]);
      expect(replies).toHaveLength(3);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    await pending;
  });
  it("后补 NFO 更新文件名占位标题；UTF-16 支持且拒绝 DTD", async () => {
    const nfoPath = path.join(media, "cancel-0.nfo");
    await fs.writeFile(
      nfoPath,
      Buffer.from("\ufeff<movie><title>后补资料</title></movie>", "utf16le"),
    );
    await host.request("library.scan", { id: directoryId });
    await host.finish();
    const found = (await host.request<NativeVideo[]>("library.videos")).find((film) =>
      film.video_path?.endsWith("cancel-0.mp4"),
    );
    expect(found?.title).toBe("后补资料");
    await fs.writeFile(
      nfoPath,
      '<!DOCTYPE movie [<!ENTITY x "test">]><movie><title>&x;</title></movie>',
    );
    await host.request("library.scan", { id: directoryId });
    expect((await host.finish()).scan?.errors).toBeGreaterThan(0);
    expect(
      (await host.request<NativeVideo[]>("library.videos")).find((film) => film.id === found?.id)
        ?.title,
    ).toBe("后补资料");
  });
  it("手工资料不会被后续 NFO 认领；快照保留未知字段及原始字节", async () => {
    const folder = path.join(root, "manual");
    await fs.mkdir(folder);
    await fs.copyFile(video, path.join(folder, "MANUAL-001.mp4"));
    const nfo = path.join(folder, "MANUAL-001.nfo");
    await fs.writeFile(
      nfo,
      "<movie><title>来源标题</title><actor><name>来源演员</name></actor></movie>",
    );
    const added = await host.request<{ directoryId: string }>("library.add", {
      path: folder,
      recursive: true,
      formats: [],
    });
    await host.finish();
    const imported = (await host.request<NativeVideo[]>("library.videos")).find((item) =>
      item.video_path?.endsWith("MANUAL-001.mp4"),
    )!;
    const database = new DatabaseSync(path.join(root, "library.sqlite3"));
    database.prepare("UPDATE works SET title='人工标题' WHERE id=?").run(imported.id);
    database.exec("INSERT INTO entities(kind,name) VALUES('actors','人工演员')");
    database
      .prepare(
        "DELETE FROM work_entities WHERE work_id=? AND entity_id IN (SELECT id FROM entities WHERE kind='actors')",
      )
      .run(imported.id);
    database
      .prepare(
        "INSERT INTO work_entities(work_id,entity_id) SELECT ?,id FROM entities WHERE kind='actors' AND name='人工演员'",
      )
      .run(imported.id);
    for (const value of ["人工", "变更"]) {
      await fs.writeFile(
        nfo,
        `<movie><title>${value}标题</title><actor><name>${value}演员</name></actor><vendor-field>未知 & 内容</vendor-field></movie>`,
      );
      await host.request("library.scan", { id: added.directoryId });
      const finished = await host.finish();
      expect(finished.scan?.warnings).toBeGreaterThan(0);
      expect(
        (await host.request<NativeVideo[]>("library.videos")).find(
          (item) => item.id === imported.id,
        ),
      ).toMatchObject({ title: "人工标题", actors: ["人工演员"] });
    }
    const source = database
      .prepare("SELECT content FROM nfo_documents WHERE work_id=? AND canonical=1")
      .get(imported.id)?.content as Uint8Array;
    expect(Buffer.from(source)).toEqual(await fs.readFile(nfo));
    await fs.writeFile(nfo, "<movie><title>坏 XML");
    await host.request("library.scan", { id: added.directoryId });
    expect((await host.finish()).scan?.state).toBe("partial");
    expect(
      Buffer.from(
        database
          .prepare("SELECT content FROM nfo_documents WHERE work_id=? AND canonical=1")
          .get(imported.id)?.content as Uint8Array,
      ),
    ).toEqual(Buffer.from(source));
    database.close();
  });
  it("手工演员排序不会被重扫恢复为 NFO 顺序", async () => {
    const folder = path.join(root, "actor-order");
    await fs.mkdir(folder);
    await fs.copyFile(video, path.join(folder, "ORDER-001.mp4"));
    const nfo = path.join(folder, "ORDER-001.nfo");
    const source =
      "<movie><actor><name>排序甲</name><order>0</order></actor><actor><name>排序乙</name><order>1</order></actor></movie>";
    await fs.writeFile(nfo, source);
    const added = await host.request<{ directoryId: string }>("library.add", {
      path: folder,
      recursive: true,
      formats: [],
    });
    await host.finish();
    const imported = (await host.request<NativeVideo[]>("library.videos")).find((item) =>
      item.video_path?.endsWith("ORDER-001.mp4"),
    )!;
    const database = new DatabaseSync(path.join(root, "library.sqlite3"));
    database
      .prepare(
        "UPDATE work_entities SET priority=1-priority WHERE work_id=? AND entity_id IN (SELECT id FROM entities WHERE kind='actors')",
      )
      .run(imported.id);
    database.close();
    await fs.writeFile(nfo, source.replace("<movie>", "<movie><title>改变签名</title>"));
    await host.request("library.scan", { id: added.directoryId });
    await host.finish();
    expect(
      (await host.request<NativeVideo[]>("library.videos")).find((item) => item.id === imported.id)
        ?.actors,
    ).toEqual(["排序乙", "排序甲"]);
  });
  it("本地图片引用限制在所选目录内，区分海报、横图、背景与演员头像", async () => {
    const folder = path.join(root, "artwork");
    const images = path.join(folder, "images");
    await fs.mkdir(images, { recursive: true });
    await fs.copyFile(video, path.join(folder, "ART-001.mp4"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG6kAAAAASUVORK5CYII=",
      "base64",
    );
    for (const file of [
      path.join(root, "outside.png"),
      ...["cover.png", "wide.png", "back.png", "actor.png"].map((name) => path.join(images, name)),
    ])
      await fs.writeFile(file, png);
    // Windows 目录联接无需开发者模式；该引用不得绕过所选根目录边界。
    const outside = path.join(root, "external-art");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "linked.png"), png);
    await fs.symlink(outside, path.join(folder, "linked"), "junction");
    await fs.writeFile(
      path.join(folder, "ART-001.nfo"),
      '<movie><poster>../outside.png</poster><poster>linked/linked.png</poster><poster>https://example.invalid/remote.png</poster><poster>images/cover.png</poster><thumb aspect="landscape">images/wide.png</thumb><fanart><thumb>images/back.png</thumb></fanart><actor><name>测试演员</name><thumb>images/actor.png</thumb></actor></movie>',
    );
    await host.request("library.add", { path: folder, recursive: true, formats: [] });
    expect((await host.finish()).scan?.errors).toBe(0);
    const result = (await host.request<NativeVideo[]>("library.videos")).find((item) =>
      item.video_path?.endsWith("ART-001.mp4"),
    );
    expect(result).toMatchObject({
      poster: path.join(images, "cover.png"),
      thumb: path.join(images, "wide.png"),
      fanart: path.join(images, "back.png"),
    });
  });
});
