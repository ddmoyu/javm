import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { LibraryStatus, NativeVideo } from "../frontend/src/contracts/library";
import { LibraryService, toFilm } from "../frontend/src/services/library/LibraryService";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { MediaHost } from "./helpers/mediaHost";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));

describe.runIf(enabled)("目录删除：隔离合成数据库", () => {
  let root: string;
  let managed: string;
  let host: MediaHost;
  let database: DatabaseSync;
  let library: LibraryService;

  beforeEach(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/directory-removal-"));
    managed = path.join(root, "媒体_%");
    const seed = createLibraryFixture(path.join(root, "library.sqlite3"));
    seed.exec("INSERT INTO entities(id,kind,name) VALUES(1,'actors','合成演员')");
    const directory = seed.prepare("INSERT INTO directories(id,path,path_key) VALUES(?,?,?)");
    const key = (value: string) => value.replaceAll("\\", "/").toLowerCase();
    for (const [id, folder] of [
      ["managed", managed],
      ["parent", root],
      ["neighbor", managed + "-邻居"],
    ])
      directory.run(id!, folder!, key(folder!));
    for (const [id, folder] of [
      ["remove", managed],
      ["missing", path.join(managed, "子目录")],
      ["neighbor", managed + "-邻居"],
      ["wildcard", path.join(root, "媒体Xabc")],
    ] as const) {
      const file = path.join(folder, `${id}.mp4`);
      seed
        .prepare("INSERT INTO works(id,title,favorite) VALUES(?,?,?)")
        .run(id, `合成影片 ${id}`, id === "remove" ? 1 : 0);
      seed
        .prepare(
          "INSERT INTO media_files(id,work_id,path,path_key,dir_path,missing) VALUES(?,?,?,?,?,?)",
        )
        .run(id, id, file, key(file), folder, id === "missing" ? 1 : 0);
      seed.prepare("INSERT INTO work_entities(work_id,entity_id) VALUES(?,1)").run(id);
    }
    const nfo = path.join(managed, "movie.nfo");
    seed
      .prepare(
        "INSERT INTO nfo_documents(work_id,path,path_key,canonical,content) VALUES('remove',?,?,1,?)",
      )
      .run(nfo, key(nfo), Buffer.from("<movie/>"));
    seed.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads-v1.sqlite3"));
    await host.request("library.status");
    database = new DatabaseSync(path.join(root, "library.sqlite3"));
    library = new LibraryService({
      request: host.request.bind(host),
      mount: async () => () => undefined,
    });
    await library.initialize();
  });

  afterEach(async () => {
    await library?.shutdown();
    database?.close();
    await host?.close();
  });

  it("离线目录停止管理，保留作品、收藏、关联与详情", async () => {
    await expect(fs.stat(managed)).rejects.toThrow();
    const view = library.createFilmQuery();
    library.attach(view);
    view.configure({}, true);
    await vi.waitFor(() => expect(view.getSnapshot().total).toBe(4));
    library.selectFilm(
      toFilm(await host.request<NativeVideo>("library.video", { id: "remove" }), () => undefined),
    );
    const before = library.getSnapshot().revision;
    await expect(library.removeDirectory("managed")).resolves.toEqual({ removedVideos: 0 });
    await vi.waitFor(() => expect(view.getSnapshot().total).toBe(4));
    expect(library.getSnapshot()).toMatchObject({
      total: 4,
      favorites: 1,
      selectedFilm: expect.objectContaining({ id: "remove" }),
      revision: before + 1,
    });
    expect(
      library
        .getSnapshot()
        .directories.map((item) => item.id)
        .sort(),
    ).toEqual(["neighbor", "parent"]);
    expect(
      library.getSnapshot().directories.find((item) => item.id === "parent")?.video_count,
    ).toBe(3);
    expect(database.prepare("SELECT id FROM works ORDER BY id").all()).toEqual([
      { id: "missing" },
      { id: "neighbor" },
      { id: "remove" },
      { id: "wildcard" },
    ]);
    expect(database.prepare("SELECT work_id FROM work_entities ORDER BY work_id").all()).toEqual([
      { work_id: "missing" },
      { work_id: "neighbor" },
      { work_id: "remove" },
      { work_id: "wildcard" },
    ]);
    expect(database.prepare("SELECT * FROM nfo_documents").all()).toHaveLength(1);
    expect(database.prepare("SELECT * FROM directories WHERE id='managed'").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await expect(library.removeDirectory("managed")).rejects.toThrow("媒体目录不存在");
    expect(library.getSnapshot().total).toBe(4);
  });

  it("目录不存在导致重扫失败后仍可停止管理，保留作品", async () => {
    await expect(fs.stat(managed)).rejects.toThrow();
    await expect(library.scan("managed")).rejects.toThrow("目录不存在、磁盘离线或无法访问");
    expect(library.getSnapshot().directories.find((item) => item.id === "managed")).toMatchObject({
      state: "failed",
      error: "目录不存在、磁盘离线或无法访问",
    });

    await expect(library.removeDirectory("managed")).resolves.toEqual({ removedVideos: 0 });
    expect(library.getSnapshot().directories.some((item) => item.id === "managed")).toBe(false);
    expect(library.getSnapshot()).toMatchObject({ total: 4, favorites: 1 });
    expect(database.prepare("SELECT id FROM works ORDER BY id").all()).toEqual([
      { id: "missing" },
      { id: "neighbor" },
      { id: "remove" },
      { id: "wildcard" },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("目录记录删除失败时，影片、收藏和资料在同一事务中回滚", async () => {
    database.exec(
      "CREATE TRIGGER reject_directory_delete BEFORE DELETE ON directories BEGIN SELECT RAISE(ABORT,'合成删除失败'); END",
    );
    await expect(library.removeDirectory("managed")).rejects.toThrow("合成删除失败");
    expect(library.getSnapshot()).toMatchObject({ total: 4, favorites: 1 });
    expect(library.getSnapshot().directories).toHaveLength(3);
    expect(database.prepare("SELECT count(*) AS count FROM works").get()).toEqual({ count: 4 });
    expect(database.prepare("SELECT count(*) AS count FROM work_entities").get()).toEqual({
      count: 4,
    });
    expect(database.prepare("SELECT count(*) AS count FROM nfo_documents").get()).toEqual({
      count: 1,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.exec("DROP TRIGGER reject_directory_delete");
    await expect(library.removeDirectory("managed")).resolves.toEqual({ removedVideos: 0 });
  });

  it("新添加目录可删除并重新添加，扫描状态清理且磁盘文件保留", async () => {
    // 合成库的 parent 覆盖整个测试目录，先从媒体库移除它以允许重新添加。
    await library.removeDirectory("managed");
    await library.removeDirectory("neighbor");
    await library.removeDirectory("parent");
    await fs.mkdir(managed);
    const marker = path.join(managed, "保留文件.txt");
    await fs.writeFile(marker, "synthetic marker", "utf8");
    const addAndFinish = async () => {
      await library.add({ path: managed, recursive: true, formats: [] });
      await vi.waitFor(async () => {
        const status = await host.request<LibraryStatus>("library.status");
        expect(status.scan?.state).toBe("completed");
      });
      await library.refresh();
      return library.getSnapshot().directories[0]!.id;
    };
    const id = await addAndFinish();
    await library.removeDirectory(id);
    expect(library.getSnapshot()).toMatchObject({ directories: [], scan: null, total: 4 });
    expect(await fs.readFile(marker, "utf8")).toBe("synthetic marker");
    const secondId = await addAndFinish();
    expect(secondId).not.toBe(id);
    expect(library.getSnapshot().directories).toHaveLength(1);
  });
});
