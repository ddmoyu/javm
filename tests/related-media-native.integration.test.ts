import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("分卷关联（安全 STRM，无网络）", () => {
  let host: MediaHost,
    root: string,
    work: string,
    files: { id: string; part: number }[];
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
  it("按明确分卷序号排序，手动调整分卷后可持久化", async () => {
    expect(files.map((file) => file.part)).toEqual([1, 2]);
    await host.request("library.related.save", { id: files[0]!.id, part: 1, parts: 2 });
    const saved = await host.request<{ media_files: typeof files }>("library.video", { id: work });
    expect(saved.media_files[0]?.part).toBe(1);
  });
  it("非法分卷与字幕请求均拒绝，磁盘旁路文件保持原样", async () => {
    const sidecar = path.join(root, "SAFE-001-CD1.zh.srt");
    await fs.writeFile(sidecar, "safe archived sidecar");
    await expect(host.request("library.related.save", { id: files[0]!.id, part: 3, parts: 2 })).rejects.toThrow("参数");
    await expect(host.request("library.related.save", { id: files[0]!.id, part: 1, parts: 2, subtitles: [sidecar] })).rejects.toThrow("范围");
    expect(await fs.readFile(sidecar, "utf8")).toBe("safe archived sidecar");
  });
});