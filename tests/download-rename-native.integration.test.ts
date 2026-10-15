import { describe, it, expect } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("下载改名日志（安全文本文件，无媒体播放）", () => {
  it("原子改名可跨进程恢复，重复请求不会覆盖目标", async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/download-rename-"));
    createLibraryFixture(path.join(root, "library.sqlite3")).close();
    const source = path.join(root, "safe.mp4"),
      target = path.join(root, "renamed.mp4");
    await fs.writeFile(source, "safe fictional fixture");
    const params = { source, target, operationId: crypto.randomUUID(), rename: true };
    let host = new MediaHost();
    try {
      await host.start(path.join(root, "downloads.sqlite3"));
      await host.request("library.files.prepare", params);
      await host.close();
      host = new MediaHost();
      await host.start(path.join(root, "downloads.sqlite3"));
      await host.request("library.files.commit", { id: params.operationId });
      await host.request("library.files.prepare", params);
      await host.request("library.files.commit", { id: params.operationId });
      expect(await fs.readFile(target, "utf8")).toBe("safe fictional fixture");
      await expect(fs.stat(source)).rejects.toThrow();
    } finally {
      await host.close();
    }
  });
});
