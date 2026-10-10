import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import type { FileOperation } from "../frontend/src/services/library/FileOrganizationService";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("文件整理恢复（安全 STRM 文件，不访问网络）", () => {
  let host: MediaHost, root: string, source: string, mediaId: string;
  const content = "https://safe.example.invalid/fixture.m3u8\n";
  beforeAll(async () => {
    root = path.resolve(await fs.mkdtemp(".tmp/file-organization-"));
    source = path.join(root, "safe.strm");
    await fs.mkdir(path.join(root, "destination"));
    createLibraryFixture(path.join(root, "library.sqlite3")).close();
    await fs.writeFile(source, content);
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    await host.request("library.status");
    await host.request("library.documents.importStream", {
      path: source,
      content,
      url: content.trim(),
    });
    const page = await host.request<{ items: { id: string }[] }>("library.maintenance.read");
    mediaId = page.items[0]!.id;
  });
  afterAll(async () => {
    await host?.close();
  });
  it("损坏的副本无法提交，取消仅清理受管临时文件", async () => {
    const operation = await host.request<FileOperation>("library.files.prepare", {
      mediaId,
      target: path.join(root, "destination", "safe.strm"),
    });
    await fs.appendFile(operation.temporary, "broken");
    await expect(host.request("library.files.verify", { id: operation.id })).rejects.toThrow(
      "核对失败",
    );
    await expect(host.request("library.files.commit", { id: operation.id })).rejects.toThrow();
    await host.request("library.files.abort", { id: operation.id });
    expect(await fs.readFile(source, "utf8")).toBe(content);
    await expect(fs.stat(operation.temporary)).rejects.toThrow();
  });
  it("复制进度跨进程恢复，提交幂等且资源身份保留", async () => {
    const destination = path.join(root, "destination", "safe.strm");
    const operation = await host.request<FileOperation>("library.files.prepare", {
      mediaId,
      target: destination,
    });
    await fs.appendFile(operation.temporary, content);
    await host.request("library.files.verify", { id: operation.id });
    await host.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    const pending = await host.request<FileOperation[]>("library.files.list");
    expect(pending[0]?.verified).toBe(Buffer.byteLength(content));
    await host.request("library.files.commit", { id: operation.id });
    await host.request("library.files.commit", { id: operation.id });
    await expect(fs.stat(source)).rejects.toThrow();
    expect(await fs.readFile(destination, "utf8")).toBe(content);
    const page = await host.request<{ items: { id: string; path: string }[] }>(
      "library.maintenance.read",
    );
    expect(page.items[0]).toMatchObject({ id: mediaId, path: destination });
    expect(await host.request("library.files.list")).toEqual([]);
  });
  it("目标存在时拒绝覆盖", async () => {
    const target = path.join(root, "protected.strm");
    await fs.writeFile(target, "keep");
    await expect(host.request("library.files.prepare", { mediaId, target })).rejects.toThrow(
      "已存在",
    );
    expect(await fs.readFile(target, "utf8")).toBe("keep");
  });
});
