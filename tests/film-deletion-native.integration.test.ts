import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import { LibraryMaintenanceService } from "../frontend/src/services/library/LibraryMaintenanceService";
import type { NativeVideo } from "../frontend/src/contracts/library";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const hosts: MediaHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function fixture(metadataOnly = false) {
  await fs.mkdir(".tmp", { recursive: true });
  const root = path.resolve(await fs.mkdtemp(".tmp/film-deletion-"));
  const names = [
    "SAFE-A-1.nfo",
    "SAFE-A-1.nfo.javm.bak",
    "SAFE-A-poster.jpg",
    "safe-screenshot.jpg",
    "shared.jpg",
    "neighbor.mp4",
    "unrelated.txt",
  ];
  if (!metadataOnly) names.push("SAFE-A-1.mp4", "SAFE-A-2.mkv");
  for (const name of names)
    await fs.writeFile(
      path.join(root, name),
      `safe synthetic fixture: ${name}; never displayed or played`,
    );
  const db = createLibraryFixture(path.join(root, "library.sqlite3"));
  const features = await fs.readFile(
    new URL("../native/media/src/library_features_schema.inc", import.meta.url),
    "utf8",
  );
  db.exec(features.slice(features.indexOf('R"SQL(') + 6, features.lastIndexOf(')SQL"')));
  db.exec(
    "INSERT INTO works(id,code,code_key,title,favorite) VALUES('target','SAFE-A','safea','虚构山林纪录片',1),('neighbor','SAFE-B','safeb','虚构河流纪录片',0)",
  );
  const file = (name: string) => path.join(root, name);
  const key = (name: string) => file(name).replaceAll("\\", "/").toLowerCase();
  const video = db.prepare(
    "INSERT INTO media_files(id,work_id,path_key,path,dir_path,file_size) VALUES(?,?,?,?,?,10)",
  );
  video.run("neighbor-video", "neighbor", key("neighbor.mp4"), file("neighbor.mp4"), root);
  if (!metadataOnly) {
    video.run("video-one", "target", key("SAFE-A-1.mp4"), file("SAFE-A-1.mp4"), root);
    video.run("video-two", "target", key("SAFE-A-2.mkv"), file("SAFE-A-2.mkv"), root);
    video.run("missing-video", "target", key("missing.mp4"), file("missing.mp4"), root);
  }
  db.prepare(
    "INSERT INTO nfo_documents(path_key,work_id,path,canonical) VALUES(?,'target',?,1)",
  ).run(key("SAFE-A-1.nfo"), file("SAFE-A-1.nfo"));
  db.prepare("UPDATE works SET poster=?,thumb=? WHERE id='target'").run(
    file("SAFE-A-poster.jpg"),
    file("shared.jpg"),
  );
  db.prepare("UPDATE works SET poster=? WHERE id='neighbor'").run(file("shared.jpg"));
  db.prepare(
    "INSERT INTO work_artwork(id,work_id,path,kind) VALUES('screenshot','target',?,'screenshot')",
  ).run(file("safe-screenshot.jpg"));
  db.exec("INSERT INTO work_sources(provider,source_id,work_id) VALUES('safe','safe-a','target')");
  db.close();
  const host = new MediaHost();
  hosts.push(host);
  await host.start(file("downloads.sqlite3"));
  const port = {
    request: <T>(method: string, params?: unknown) => host.request<T>(method, params),
    mount: async () => () => undefined,
  };
  const library = new LibraryService(port);
  await library.initialize();
  const files = {
    remove: vi.fn(async (target: string) => {
      const resolved = path.resolve(target);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("拒绝删除测试目录之外的文件");
      await fs.unlink(resolved);
    }),
  };
  const maintenance = new LibraryMaintenanceService(
    port,
    files,
    { read: async () => null, write: async () => {} },
    () => {
      throw new Error("本用例不启动 Worker");
    },
    () => library.refreshAfterImport(),
  );
  const preview = () => maintenance.previewWorkRemoval("target");
  return { root, file, host, files, library, maintenance, preview };
}

describe.runIf(enabled)("影片删除两种模式（隔离安全文件与真实扩展）", () => {
  it("仅删除视频保留资料；彻底删除清理全部独占文件并刷新卡片、收藏和详情", async () => {
    const f = await fixture();
    await f.maintenance.removeResource({ id: "video-one", path: f.file("SAFE-A-1.mp4") });
    const retained = await f.host.request<NativeVideo>("library.video", { id: "target" });
    expect(retained.favorite).toBe(1);
    expect(retained.media_files?.map((file) => file.id)).not.toContain("video-one");
    await expect(fs.stat(f.file("SAFE-A-1.nfo"))).resolves.toBeDefined();

    const view = f.library.createFilmQuery();
    const detach = f.library.attach(view);
    try {
      view.configure({ scope: "favorites" }, true);
      await vi.waitFor(() => expect(view.getSnapshot().ready).toBe(true));
      await f.library.openWork("target");
      const plan = await f.preview();
      expect(plan.preservedFiles.map((file) => path.resolve(file.path))).toEqual([
        f.file("shared.jpg"),
      ]);
      expect(plan.files.some((file) => file.kind === "backup" && file.exists)).toBe(true);
      await f.maintenance.removeWork(plan);
      await vi.waitFor(() => expect(view.getSnapshot().total).toBe(0));
      expect(view.getSnapshot().items.size).toBe(0);
      expect(f.library.getSnapshot()).toMatchObject({ total: 1, favorites: 0, selectedFilm: null });
      for (const name of [
        "SAFE-A-2.mkv",
        "SAFE-A-1.nfo",
        "SAFE-A-1.nfo.javm.bak",
        "SAFE-A-poster.jpg",
        "safe-screenshot.jpg",
      ])
        await expect(fs.stat(f.file(name))).rejects.toMatchObject({ code: "ENOENT" });
      for (const name of ["shared.jpg", "neighbor.mp4", "unrelated.txt"])
        await expect(fs.stat(f.file(name))).resolves.toBeDefined();
      expect(await f.host.request("library.video", { id: "target" })).toBeNull();
      expect(await f.host.request("library.video", { id: "neighbor" })).not.toBeNull();
    } finally {
      detach();
    }
  });

  it("没有视频的资料卡片也能彻底删除", async () => {
    const f = await fixture(true);
    const plan = await f.preview();
    expect(plan.files.every((file) => file.kind !== "video")).toBe(true);
    await f.maintenance.removeWork(plan);
    expect(await f.host.request("library.video", { id: "target" })).toBeNull();
    await expect(fs.stat(f.file("SAFE-A-1.nfo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("确认前文件变化会拒绝过期清单，不删除任何文件，重读后可重试", async () => {
    const f = await fixture();
    const plan = await f.preview();
    await fs.appendFile(f.file("SAFE-A-1.mp4"), "safe changed content");
    await expect(f.maintenance.removeWork(plan)).rejects.toThrow("删除清单已变化");
    expect(f.files.remove).not.toHaveBeenCalled();
    expect(await f.host.request("library.video", { id: "target" })).not.toBeNull();
    await f.maintenance.removeWork(await f.preview());
    expect(await f.host.request("library.video", { id: "target" })).toBeNull();
  });

  it.each(["changed", "restored"])("逐文件校验拒绝准备后变化或恢复的文件：%s", async (mode) => {
    const f = await fixture();
    const expected = await f.preview();
    const token = crypto.randomUUID();
    await f.host.request("library.maintenance.prepareWork", { token, id: "target", expected });
    const target = f.file(mode === "changed" ? "SAFE-A-1.mp4" : "missing.mp4");
    await fs.writeFile(target, "safe replacement or restored synthetic file");
    await expect(
      f.host.request("library.maintenance.checkFile", { token, path: target }),
    ).rejects.toThrow(mode === "changed" ? "关联文件已变化" : "原本缺失的文件已恢复");
    await expect(f.host.request("library.maintenance.complete", { token })).rejects.toThrow(
      "文件尚未删除",
    );
    expect(await f.host.request("library.video", { id: "target" })).not.toBeNull();
    await f.host.request("library.maintenance.abort", { token });
  });

  it("删除中途失败保留影片记录，刷新清单后可完成剩余删除", async () => {
    const f = await fixture();
    const remove = f.files.remove.getMockImplementation()!;
    f.files.remove.mockImplementationOnce(remove).mockRejectedValueOnce(new Error("模拟文件占用"));
    await expect(f.maintenance.removeWork(await f.preview())).rejects.toThrow("模拟文件占用");
    expect(f.files.remove).toHaveBeenCalledTimes(2);
    expect(f.maintenance.getSnapshot().phase).toBe("idle");
    expect(await f.host.request("library.video", { id: "target" })).not.toBeNull();
    await f.maintenance.removeWork(await f.preview());
    expect(await f.host.request("library.video", { id: "target" })).toBeNull();
  });

  it("停止删除不再处理下一文件，也不提交影片记录删除", async () => {
    const f = await fixture();
    const remove = f.files.remove.getMockImplementation()!;
    f.files.remove.mockImplementationOnce(async (file) => {
      await remove(file);
      f.maintenance.cancel();
    });
    await expect(f.maintenance.removeWork(await f.preview())).rejects.toThrow("停止");
    expect(f.files.remove).toHaveBeenCalledTimes(1);
    expect(await f.host.request("library.video", { id: "target" })).not.toBeNull();
    expect(f.maintenance.getSnapshot()).toMatchObject({ phase: "idle", cancelling: false });
  });

  it("资料路径变成目录时拒绝生成清单，不递归删除", async () => {
    const f = await fixture(true);
    await fs.unlink(f.file("SAFE-A-1.nfo"));
    await fs.mkdir(f.file("SAFE-A-1.nfo"));
    await expect(f.preview()).rejects.toThrow("不是普通文件");
    expect(f.files.remove).not.toHaveBeenCalled();
  });
});
