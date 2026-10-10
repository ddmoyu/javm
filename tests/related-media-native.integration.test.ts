import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("分卷和字幕关联（安全 STRM，无网络）", () => {
  let host: MediaHost,
    root: string,
    work: string,
    files: { id: string; part: number; subtitles: string[] }[];
  beforeAll(async () => {
    root = path.resolve(await fs.mkdtemp(".tmp/related-media-"));
    createLibraryFixture(path.join(root, "library.sqlite3")).close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    for (const part of [2, 1]) {
      const file = path.join(root, `SAFE-001-CD${part}.strm`),
        content = "https://safe.example.invalid/sample.m3u8\n";
      await fs.writeFile(file, content);
      await fs.writeFile(
        file.replace(/\.strm$/, ".nfo"),
        "<movie><title>安全分卷样例</title><num>SAFE-001</num></movie>",
      );
      await host.request("library.documents.importStream", {
        path: file,
        content,
        url: content.trim(),
      });
    }
    const page = await host.request<{ items: { id: string; media_files: typeof files }[] }>(
      "library.query",
    );
    expect(page.items).toHaveLength(1);
    work = page.items[0]!.id;
    files = page.items[0]!.media_files;
  });
  afterAll(async () => {
    await host?.close();
  });
  it("按明确分卷序号排序，可手动指定并持久化字幕", async () => {
    expect(files.map((file) => file.part)).toEqual([1, 2]);
    const subtitle = path.join(root, "SAFE-001-CD1.zh.srt");
    await fs.writeFile(subtitle, "1\n00:00:00,000 --> 00:00:01,000\n安全字幕\n");
    expect(await host.request("library.related.discover", { id: files[0]!.id })).toEqual([
      subtitle,
    ]);
    await host.request("library.related.save", {
      id: files[0]!.id,
      part: 1,
      parts: 2,
      subtitles: [subtitle],
    });
    const saved = await host.request<{ media_files: typeof files }>("library.video", { id: work });
    expect(saved.media_files[0]?.subtitles).toHaveLength(1);
  });
  it("非法关联失败后保留原关联，移除字幕关联保留磁盘文件", async () => {
    await expect(
      host.request("library.related.save", { id: files[0]!.id, part: 3, parts: 2, subtitles: [] }),
    ).rejects.toThrow("参数");
    const saved = await host.request<{ media_files: typeof files }>("library.video", { id: work });
    expect(saved.media_files[0]?.subtitles).toHaveLength(1);
    await host.request("library.related.save", {
      id: files[0]!.id,
      part: 1,
      parts: 2,
      subtitles: [],
    });
    expect((await fs.stat(path.join(root, "SAFE-001-CD1.zh.srt"))).isFile()).toBe(true);
  });
});
