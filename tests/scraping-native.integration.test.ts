import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaHost } from "./helpers/mediaHost";
import type { ScrapeTarget } from "../frontend/src/services/scraping/ScrapeService";
import type { NativeVideo } from "../frontend/src/contracts/library";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";
import { editableMetadata } from "../frontend/src/contracts/metadata";
import { toFilm } from "../frontend/src/services/library/LibraryService";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";

const project = fileURLToPath(new URL("../", import.meta.url));
const details: MovieDetails = {
  provider: "Fixture",
  id: "001",
  homepage: "https://example.invalid/001",
  fields: {
    code: "TEST-001",
    title: "虚构标题 & XML",
    plot: "虚构简介",
    studio: "虚构制作商",
    label: "虚构发行商",
    actors: ["虚构演员"],
    genres: ["测试分类"],
    premiered: "2025-01-02",
    rating: 4,
    duration: 120,
  },
};
describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "基础刮削原生落盘",
  () => {
    let root: string, media: string, movie: string, image: string, database: string;
    let host = new MediaHost();
    const prepare = async (videoPath = movie) => {
      const jobId = crypto.randomUUID();
      return {
        ...(await host.request<ScrapeTarget>("library.scrape.prepare", { jobId, path: videoPath })),
        jobId,
      };
    };
    const commit = (target: ScrapeTarget, data = details, artwork = "") =>
      host.request<{ warning: string; nfoPath: string }>("library.scrape.commit", {
        jobId: target.jobId,
        id: target.id,
        path: target.path,
        fileStamp: target.fileStamp,
        nfoStamp: target.nfoStamp,
        details: data,
        image: artwork,
      });
    const video = (id: string) => host.request<NativeVideo>("library.video", { id });
    beforeAll(async () => {
      await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
      root = await fs.mkdtemp(path.join(project, ".tmp/scraping-native-"));
      media = path.join(root, "media");
      await fs.mkdir(media);
      movie = path.join(media, "TEST-001.mp4");
      execFileSync(
        process.env.JAVM_FFMPEG || "ffmpeg.exe",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=navy:s=160x90:d=2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          movie,
        ],
        { windowsHide: true, timeout: 20000 },
      );
      image = path.join(root, "cover.png");
      await fs.writeFile(
        image,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      database = path.join(root, "downloads.sqlite3");
      // 合成 v1 任务库，覆盖无损升级；不读取真实用户数据库。
      const db = new DatabaseSync(database);
      const download = {
        ...createDownloadTasks(
          {
            urls: ["https://example.invalid/TEST-001.mp4"],
            kind: "auto",
            directory: media,
            headers: {},
          },
          [],
        )[0]!,
        revision: 1,
        status: "completed",
      };
      db.exec(
        "CREATE TABLE download_tasks(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))); CREATE TABLE download_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL CHECK(json_valid(payload))); PRAGMA application_id=1245793604; PRAGMA user_version=1;",
      );
      db.prepare("INSERT INTO download_tasks VALUES(?,?,?)").run(
        download.id,
        1,
        JSON.stringify(download),
      );
      db.close();
      await host.start(database);
    }, 30000);
    afterAll(async () => {
      await host.close();
    });

    it("任务库升级保留下载记录并创建可读备份", async () => {
      expect(await host.request("hello")).toMatchObject({ schema: 2 });
      expect(await host.request("downloads.load")).toMatchObject({
        tasks: [expect.objectContaining({ status: "completed", revision: 1 })],
      });
      const backup = (await fs.readdir(root)).find(
        (name) => name.startsWith("downloads.sqlite3.pre-v2-") && name.endsWith(".bak"),
      );
      expect(backup).toBeDefined();
      const db = new DatabaseSync(path.join(root, backup!), { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        expect(db.prepare("SELECT count(*) AS n FROM download_tasks").get()?.n).toBe(1);
      } finally {
        db.close();
      }
    });
    it("单文件入库后补全资料、封面和 NFO，重试不新增影片", async () => {
      const target = await prepare();
      expect(target).toMatchObject({ code: "TEST-001", hasArtwork: false, nfoStamp: "" });
      const result = await commit(target, details, image);
      expect(result.warning).toBe("");
      const saved = await video(target.id);
      expect(saved).toMatchObject({
        title: details.fields.title,
        local_id: "TEST-001",
        plot: "虚构简介",
        label: "虚构发行商",
        rating: 8,
        duration: 2,
        scan_status: 2,
        metadata_edited: false,
      });
      expect(await fs.readFile(saved.poster!)).toEqual(await fs.readFile(image));
      const nfo = await fs.readFile(result.nfoPath, "utf8");
      expect(nfo).toContain("虚构标题 &amp; XML");
      expect(nfo).toContain('type="metatube"');
      expect(nfo).toContain("Fixture:001");
      expect(nfo).toContain("<durationinseconds>2</durationinseconds>");
      expect(nfo).toContain("movie-poster.png");
      const again = await prepare();
      expect(again).toMatchObject({ id: target.id, hasArtwork: true, code: "TEST-001" });
      await commit(again);
      expect(
        await host.request<NativeVideo[]>("library.videos", { offset: 0, limit: 100 }),
      ).toHaveLength(1);
      const db = new DatabaseSync(path.join(root, "library.sqlite3"), { readOnly: true });
      try {
        const row = db
          .prepare("SELECT provenance AS nfo_data FROM works WHERE id=?")
          .get(target.id)!;
        expect(JSON.parse(row.nfo_data as string)._scrape).toMatchObject({
          provider: "Fixture",
          id: "001",
        });
        expect(JSON.parse(row.nfo_data as string)._manual).toBeUndefined();
      } finally {
        db.close();
      }
    });
    it("保留人工清空、已有演员扩展节点及原始 NFO 备份", async () => {
      const folder = path.join(root, "existing");
      await fs.mkdir(folder);
      const filename = path.join(folder, "existing.mp4");
      await fs.copyFile(movie, filename);
      const nfoPath = path.join(folder, "movie.nfo");
      const original =
        '<movie><!-- retained --><title>已有标题</title><num>EXIST-002</num><maker>旧制作商</maker><actor><name>已有演员</name><role>保留角色</role><thumb>avatar.jpg</thumb></actor><custom key="value">扩展内容</custom></movie>';
      await fs.writeFile(nfoPath, original);
      let target = await prepare(filename);
      await host.request("library.updateMetadata", {
        id: target.id,
        expected: editableMetadata(toFilm(await video(target.id), () => undefined)),
        patch: { studio: "", plot: "人工简介" },
      });
      target = await prepare(filename);
      expect(
        (
          await commit(target, {
            ...details,
            id: "002",
            fields: { ...details.fields, code: "EXIST-002" },
          })
        ).nfoPath,
      ).toBe(nfoPath);
      expect(await video(target.id)).toMatchObject({
        title: "已有标题",
        studio: "",
        plot: "人工简介",
        actors: ["已有演员"],
        metadata_edited: true,
      });
      const nfo = await fs.readFile(nfoPath, "utf8");
      expect(nfo).toContain("<!-- retained -->");
      expect(nfo).toContain('<custom key="value">扩展内容</custom>');
      expect(nfo).toContain("保留角色");
      expect(nfo).toContain("人工简介");
      expect(nfo).not.toContain("旧制作商");
      expect(await fs.readFile(`${nfoPath}.javm.bak`, "utf8")).toBe(original);
      await prepare(filename);
      expect(await video(target.id)).toMatchObject({ studio: "", plot: "人工简介" });
    });
    it("网络等待期间 NFO 被外部修改时拒绝覆盖，重试重新读取", async () => {
      const target = await prepare();
      const nfoPath = (await video(target.id)).nfo_path;
      const changed = "<movie><title>外部最新标题</title><num>TEST-001</num></movie>";
      await fs.writeFile(nfoPath, changed);
      await expect(commit(target)).rejects.toThrow("NFO 已被修改");
      expect(await fs.readFile(nfoPath, "utf8")).toBe(changed);
      const fresh = await prepare();
      await commit(fresh);
      expect((await video(target.id)).title).toBe("外部最新标题");
    });
    it("错误图片只影响封面，错误番号不会改动元数据文件", async () => {
      const target = await prepare();
      const bad = path.join(root, "bad-image");
      await fs.writeFile(bad, "<html>blocked</html>");
      expect((await commit(target, details, bad)).warning).toContain("不是支持的图片格式");
      const fresh = await prepare();
      const nfoPath = (await video(target.id)).nfo_path;
      const before = await fs.readFile(nfoPath);
      await expect(
        commit(fresh, { ...details, fields: { ...details.fields, code: "TEST-999" } }),
      ).rejects.toThrow("番号与片库不一致");
      expect(await fs.readFile(nfoPath)).toEqual(before);
    });
    it("取消后的新尝试使用独立身份，不受旧取消影响", async () => {
      const jobId = crypto.randomUUID();
      await host.request("library.scrape.cancel", { jobId });
      await expect(host.request("library.scrape.prepare", { jobId, path: movie })).rejects.toThrow(
        "已取消",
      );
      expect((await prepare()).id).toBeTruthy();
    });
    it("刮削任务乐观锁生效且扩展重启后可恢复", async () => {
      const task: ScrapeTask = {
        id: crypto.randomUUID(),
        revision: 1,
        name: "TEST-001",
        path: movie,
        status: "running",
        phase: "search",
        error: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await host.request("scraping.save", { task, expectedRevision: 0 });
      await expect(
        host.request("scraping.save", { task: { ...task, revision: 3 }, expectedRevision: 2 }),
      ).rejects.toThrow("其他操作修改");
      await host.close();
      host = new MediaHost();
      await host.start(database);
      expect(await host.request("scraping.load", { offset: 0 })).toEqual([task]);
      expect(await host.request("downloads.load")).toMatchObject({
        tasks: [expect.objectContaining({ status: "completed" })],
      });
    });
  },
);
