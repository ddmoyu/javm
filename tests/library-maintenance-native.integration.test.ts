import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { MediaHost } from "./helpers/mediaHost";
import type { MaintenanceVideo, RemovalPlan } from "../frontend/src/contracts/maintenance";
import type { LibraryStatus } from "../frontend/src/contracts/library";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("片库清理：仅隔离合成文件与数据库", () => {
  let root: string, media: string, host: MediaHost, database: DatabaseSync;
  beforeEach(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/library-maintenance-"));
    media = path.join(root, "合成_%");
    await fs.mkdir(media);
    const seed = createLibraryFixture(path.join(root, "library.sqlite3"));
    const key = (value: string) => value.replaceAll("\\", "/").toLowerCase();
    seed
      .prepare("INSERT INTO directories(id,path,path_key) VALUES('directory',?,?)")
      .run(media, key(media));
    for (const id of ["a", "b"]) {
      const file = path.join(media, `${id}.mp4`);
      await fs.writeFile(file, "synthetic media for removal only");
      seed
        .prepare(
          "INSERT INTO works(id,title,code,code_key,studio,poster) VALUES(?,?,? ,?,'合成厂商',?)",
        )
        .run(id, `合成 ${id}`, `TEST-00${id}`, `test00${id}`, path.join(media, "shared.jpg"));
      seed
        .prepare(
          "INSERT INTO media_files(id,work_id,path,path_key,dir_path,file_size,fast_hash) VALUES(?,?,?,?,?,0,'legacy-hash')",
        )
        .run(id, id, file, key(file), media);
    }
    const nfo = path.join(media, "a.nfo");
    seed
      .prepare("INSERT INTO nfo_documents(work_id,path,path_key,canonical) VALUES('a',?,?,1)")
      .run(nfo, key(nfo));
    await fs.writeFile(path.join(media, "shared.jpg"), "shared");
    await fs.writeFile(path.join(media, "a.nfo"), "<movie><title>合成</title></movie>");
    await fs.writeFile(path.join(media, "a.srt"), "subtitle");
    await fs.writeFile(path.join(media, "a-poster.jpg"), "private");
    await fs.writeFile(path.join(media, "unrelated.txt"), "keep");
    seed.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads-v1.sqlite3"));
    await host.request("library.status");
    database = new DatabaseSync(path.join(root, "library.sqlite3"));
  });
  afterEach(async () => {
    database?.close();
    await host?.close();
  });
  const prepare = async (metadataOnly = false, id = "a") => {
    const token = crypto.randomUUID();
    return host.request<RemovalPlan>("library.maintenance.prepare", {
      token,
      id,
      path: path.join(media, `${id}.mp4`),
      metadataOnly,
    });
  };
  const execute = async (plan: RemovalPlan) => {
    for (const file of plan.files) {
      // 测试删除前独立确认实际路径只在本用例新建目录内。
      expect(path.resolve(file.path).startsWith(path.resolve(root) + path.sep)).toBe(true);
      if (
        (
          await host.request<{ exists: boolean }>("library.maintenance.checkFile", {
            token: plan.token,
            path: file.path,
          })
        ).exists
      )
        await fs.unlink(file.path);
    }
    await host.request("library.maintenance.complete", { token: plan.token });
  };
  it("删除实体视频，保留旁路文件、作品、NFO、封面并更新目录计数", async () => {
    const before = await host.request<LibraryStatus>("library.status");
    const plan = await prepare();
    expect(plan.files.map((file) => path.basename(file.path))).toEqual(
      ["a.mp4"],
    );
    expect(plan.files.some((file) => file.path.endsWith("shared.jpg"))).toBe(false);
    await expect(host.request("library.scan", { id: "directory" })).rejects.toThrow("正在清理");
    await expect(
      host.request("library.maintenance.complete", { token: plan.token }),
    ).rejects.toThrow("尚未删除");
    expect(database.prepare("SELECT id FROM media_files WHERE id='a'").get()).toBeTruthy();
    await execute(plan);
    expect(database.prepare("SELECT id FROM media_files ORDER BY id").all()).toEqual([{ id: "b" }]);
    for (const name of ["b.mp4", "a.srt", "a.nfo", "a-poster.jpg", "shared.jpg", "unrelated.txt"])
      expect(await fs.readFile(path.join(media, name), "utf8")).not.toBe("");
    expect((await host.request<LibraryStatus>("library.status")).directories[0]?.video_count).toBe(
      1,
    );
    expect((await host.request<LibraryStatus>("library.status")).revision).toBe(
      before.revision + 1,
    );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("不同容器的同名视频共享 NFO、封面和字幕，不随其中一个视频删除", async () => {
    const other = path.join(media, "a.mkv");
    await fs.writeFile(other, "synthetic second container");
    database
      .prepare(
        "INSERT INTO media_files(id,work_id,path,path_key,dir_path) VALUES('alternative','a',?,?,?)",
      )
      .run(other, other.replaceAll("\\", "/").toLowerCase(), media);
    database
      .prepare("UPDATE works SET poster=? WHERE id='b'")
      .run(path.join(media, "shared.jpg").toUpperCase().replaceAll("\\", "/"));
    const plan = await prepare();
    expect(plan.files.map((file) => path.basename(file.path))).toEqual(["a.mp4"]);
    await execute(plan);
    for (const name of ["a.mkv", "a.nfo", "a.srt", "a-poster.jpg", "shared.jpg"])
      expect(await fs.stat(path.join(media, name))).toBeTruthy();
  });
  it("仅清除刮削资料保留视频、字幕、收藏与记录", async () => {
    database
      .prepare("UPDATE works SET favorite=1,poster=? WHERE id='a'")
      .run(path.join(media, "a-poster.jpg"));
    const plan = await prepare(true);
    expect(plan.files.some((file) => /\.(mp4|srt)$/.test(file.path))).toBe(false);
    await execute(plan);
    expect(await fs.stat(path.join(media, "a.mp4"))).toBeTruthy();
    expect(await fs.stat(path.join(media, "a.srt"))).toBeTruthy();
    expect(
      database.prepare("SELECT code,studio,poster,favorite FROM works WHERE id='a'").get(),
    ).toEqual({ code: "TEST-00a", studio: "", poster: "", favorite: 1 });
    expect(database.prepare("SELECT * FROM nfo_documents WHERE work_id='a'").all()).toEqual([]);
  });
  it("文件变化、越界请求和取消后旧请求均被拒绝，失败不删除记录", async () => {
    const plan = await prepare();
    await fs.appendFile(path.join(media, "a.mp4"), "changed");
    await expect(
      host.request("library.maintenance.checkFile", {
        token: plan.token,
        path: path.join(media, "a.mp4"),
      }),
    ).rejects.toThrow("已变化");
    await expect(
      host.request("library.maintenance.checkFile", {
        token: plan.token,
        path: path.join(root, "outside.mp4"),
      }),
    ).rejects.toThrow("不属于");
    await host.request("library.maintenance.abort", { token: plan.token });
    await expect(
      host.request("library.maintenance.prepare", {
        token: plan.token,
        id: "a",
        path: path.join(media, "a.mp4"),
        metadataOnly: false,
      }),
    ).rejects.toThrow("已取消");
    expect(database.prepare("SELECT count(*) AS n FROM works").get()).toEqual({ n: 2 });
    const retry = await prepare();
    await host.request("library.maintenance.abort", { token: retry.token });
  });
  it("候选读取采用稳定游标分页，拒绝混合片库版本，保留旧指纹", async () => {
    const insert = database.prepare(
      "INSERT INTO media_files(id,work_id,path,path_key,dir_path) VALUES(?,'b',?,?,?)",
    );
    for (let i = 0; i < 505; ++i)
      insert.run(
        `z${String(i).padStart(4, "0")}`,
        path.join(media, `z${i}.mp4`),
        path.join(media, `z${i}.mp4`).replaceAll("\\", "/").toLowerCase(),
        media,
      );
    const first = await host.request<{ items: MaintenanceVideo[]; revision: number }>(
      "library.maintenance.read",
    );
    expect(first.items).toHaveLength(500);
    expect(first.items[0]?.hash).toBe("legacy-hash");
    const second = await host.request<{ items: MaintenanceVideo[] }>("library.maintenance.read", {
      after: first.items.at(-1)!.id,
      revision: first.revision,
    });
    expect(second.items).toHaveLength(7);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(507);
    await host.request("library.favorite", { id: "a", value: true });
    await expect(
      host.request("library.maintenance.read", { revision: first.revision }),
    ).rejects.toThrow("发生变化");
  });
  it("原生扫描生成与旧 Adler-32 算法一致的指纹，未变化文件可补齐指纹", async () => {
    const folder = path.join(root, "扫描合成视频");
    await fs.mkdir(folder);
    const file = path.join(folder, "TEST-009.mp4");
    execFileSync(
      "ffmpeg",
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
        file,
      ],
      { windowsHide: true },
    );
    const { directoryId } = await host.request<{ directoryId: string }>("library.add", {
      path: folder,
      recursive: true,
      formats: [],
    });
    const completed = async () =>
      vi.waitFor(async () =>
        expect((await host.request<LibraryStatus>("library.status")).scan?.state).toBe("completed"),
      );
    await completed();
    const bytes = await fs.readFile(file),
      length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    const pieces = [
      length,
      bytes.subarray(0, 4096),
      ...(bytes.length > 4096
        ? [bytes.subarray(bytes.length < 8192 ? 4096 : bytes.length - 4096)]
        : []),
    ];
    let a = 1,
      b = 0;
    for (const piece of pieces)
      for (const value of piece) {
        a = (a + value) % 65521;
        b = (b + a) % 65521;
      }
    const expected = ((b * 65536 + a) >>> 0).toString(16).padStart(8, "0");
    const query = database.prepare("SELECT id,fast_hash FROM media_files WHERE path=?");
    expect(query.get(file)?.fast_hash).toBe(expected);
    database.prepare("UPDATE media_files SET fast_hash='' WHERE path=?").run(file);
    await host.request("library.scan", { id: directoryId });
    await completed();
    expect(query.get(file)?.fast_hash).toBe(expected);
  }, 20000);
});
