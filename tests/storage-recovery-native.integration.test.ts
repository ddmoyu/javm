import { expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import type { FileOperation } from "../frontend/src/services/library/FileOrganizationService";
import type { BackupStatus } from "../frontend/src/contracts/libraryBackup";
it.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "真实 Extension 重启后继续核对部分副本，重复提交不误删且完成记录不阻止备份",
  async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/storage-recovery-safe-"));
    const source = path.join(root, "SAFE-001.strm"),
      target = path.join(root, "归档.strm");
    const content = "https://safe.example.invalid/fixture.m3u8\n";
    await fs.writeFile(source, content);
    let host = new MediaHost();
    try {
      await host.start(path.join(root, "downloads.sqlite3"));
      await host.request("library.documents.importStream", {
        path: source,
        content,
        url: content.trim(),
      });
      const videos = await host.request<{ items: { id: string }[] }>("library.maintenance.read");
      const operation = await host.request<FileOperation>("library.files.prepare", {
        mediaId: videos.items[0]!.id,
        target,
      });
      await fs.appendFile(operation.temporary, content.slice(0, 12));
      await host.request("library.files.verify", { id: operation.id });
      await host.close();
      host = new MediaHost();
      await host.start(path.join(root, "downloads.sqlite3"));
      const recovered = await host.request<FileOperation>("library.files.inspect", {
        id: operation.id,
      });
      expect(recovered.verified).toBe(12);
      expect(await fs.readFile(source, "utf8")).toBe(content);
      await fs.appendFile(recovered.temporary, content.slice(12));
      await host.request("library.files.verify", { id: operation.id });
      await host.request("library.files.commit", { id: operation.id });
      await host.request("library.files.commit", { id: operation.id });
      expect(await fs.readFile(target, "utf8")).toBe(content);
      expect(await fs.stat(source).catch(() => null)).toBeNull();
      await host.request("library.backup.start", {
        id: crypto.randomUUID(),
        operation: "create",
        directory: root,
      });
      let result: BackupStatus;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        result = await host.request<BackupStatus>("library.backup.status");
      } while (result.state === "running");
      expect(result.state, result.error).toBe("completed");
    } finally {
      await host.close();
    }
  },
);
