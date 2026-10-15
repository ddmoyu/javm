import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type { LibraryStatus, NativeVideo } from "../frontend/src/contracts/library";
import { toFilm } from "../frontend/src/services/library/LibraryService";
import { editableMetadata } from "../frontend/src/contracts/metadata";
import type { EditableMetadata } from "../frontend/src/contracts/metadata";

const project = fileURLToPath(new URL("../", import.meta.url));
describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "资料确认与 SQLite 持久化",
  () => {
    let root: string, media: string, id: string, directoryId: string;
    let host = new MediaHost();
    let initial: EditableMetadata;
    const video = () => host.request<NativeVideo>("library.video", { id });
    const expected = async () => editableMetadata(toFilm(await video(), () => undefined));
    const idle = async () => {
      await vi.waitFor(
        async () => {
          expect((await host.request<LibraryStatus>("library.status")).scan?.state).toBe(
            "completed",
          );
        },
        { timeout: 20000, interval: 100 },
      );
    };
    beforeAll(async () => {
      await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
      root = await fs.mkdtemp(path.join(project, ".tmp/metadata-native-"));
      media = path.join(root, "media");
      await fs.mkdir(media);
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
          path.join(media, "first.mp4"),
        ],
        { windowsHide: true, timeout: 20000 },
      );
      await fs.copyFile(path.join(media, "first.mp4"), path.join(media, "second.mp4"));
      await fs.writeFile(
        path.join(media, "first.nfo"),
        "<movie><title>Original title</title><num>TEST-001</num><plot>Original plot</plot><studio>Original studio</studio><actor>Original actor</actor><genre>Original genre</genre><set>Original series</set></movie>",
      );
      await fs.writeFile(
        path.join(media, "second.nfo"),
        "<movie><title>Second film</title><num>TEST-002</num></movie>",
      );
      await host.start(path.join(root, "downloads.sqlite3"));
      await host.request("library.add", {
        path: media,
        recursive: true,
        formats: [],
        concurrency: 1,
      });
      await idle();
      const videos = await host.request<NativeVideo[]>("library.videos", { offset: 0, limit: 10 });
      id = videos.find((item) => item.local_id === "TEST-001")!.id;
      directoryId = (await host.request<LibraryStatus>("library.status")).directories[0]!.id;
      initial = await expected();
    }, 30000);
    afterAll(async () => {
      await host.close();
    });
    it("确认字段落盘，未选择的番号与路径保持不变", async () => {
      await host.request("library.updateMetadata", {
        id,
        expected: initial,
        patch: {
          title: "已确认标题",
          plot: "用户确认的简介",
          studio: "",
          series: "确认系列",
          actors: ["虚构乙", "虚构甲"],
          genres: [],
          tags: ["手工标签"],
          rating: 7.5,
          duration: 90,
        },
      });
      expect(await video()).toMatchObject({
        title: "已确认标题",
        local_id: "TEST-001",
        plot: "用户确认的简介",
        studio: "",
        series: "确认系列",
        actors: ["虚构乙", "虚构甲"],
        genres: [],
        tags: ["手工标签"],
        rating: 7.5,
        duration: 5400,
        resolution: "160x90",
        metadata_edited: true,
      });
    });
    it("旧快照写入拒绝并完整回滚", async () => {
      await expect(
        host.request("library.updateMetadata", {
          id,
          expected: initial,
          patch: { title: "stale overwrite", code: "CHANGED-001" },
        }),
      ).rejects.toThrow("已被其他操作更新");
      expect(await video()).toMatchObject({ title: "已确认标题", local_id: "TEST-001" });
    });
    it("重复番号和未知字段都不会部分写入", async () => {
      const current = await expected();
      await expect(
        host.request("library.updateMetadata", {
          id,
          expected: current,
          patch: { code: "test-002", plot: "should not save" },
        }),
      ).rejects.toThrow("已存在");
      await expect(
        host.request("library.updateMetadata", {
          id,
          expected: { ...current, video_path: "" },
          patch: { video_path: "C:/elsewhere" },
        }),
      ).rejects.toThrow("不支持");
      expect((await video()).plot).toBe("用户确认的简介");
    });
    it("重扫不覆盖确认字段，含显式清空与演员顺序", async () => {
      await fs.writeFile(
        path.join(media, "first.nfo"),
        "<movie><title>New source title</title><num>TEST-001</num><plot>New source plot</plot><studio>New source studio</studio><actor>New source actor</actor><genre>New genre</genre><set>New series</set></movie>",
      );
      await host.request("library.scan", { id: directoryId, concurrency: 1 });
      await idle();
      expect(await video()).toMatchObject({
        title: "已确认标题",
        plot: "用户确认的简介",
        studio: "",
        genres: [],
        series: "确认系列",
        actors: ["虚构乙", "虚构甲"],
        duration: 5400,
        resolution: "160x90",
      });
      const db = new DatabaseSync(path.join(root, "library.sqlite3"), { readOnly: true });
      try {
        const row = db
          .prepare("SELECT content FROM nfo_documents WHERE work_id=? AND canonical=1")
          .get(id)!;
        expect(Buffer.from(row.content as Uint8Array).toString("utf8")).toContain(
          "New source title",
        );
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      } finally {
        db.close();
      }
    });
    it("重启扩展仍保留已确认资料，并可按新系列筛选", async () => {
      await host.close();
      host = new MediaHost();
      await host.start(path.join(root, "downloads.sqlite3"));
      expect(await video()).toMatchObject({
        title: "已确认标题",
        plot: "用户确认的简介",
        series: "确认系列",
        genres: [],
      });
      const page = await host.request<{ total: number }>("library.query", {
        offset: 0,
        limit: 20,
        facet: { dimension: "series", value: "确认系列" },
      });
      expect(page.total).toBe(1);
    });
  },
);
