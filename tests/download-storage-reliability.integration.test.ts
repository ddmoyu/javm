import { describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaHost } from "./helpers/mediaHost";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import type { DownloadTask } from "../frontend/src/contracts/downloads";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_DOWNLOAD_INTEGRATION === "1";
describe.runIf(enabled)("真实下载数据库容量与分页", () => {
  it("旧超限数据完整保留，按条数及字节分页；拒绝新增但允许更新和移除", async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    const directory = await fs.mkdtemp(path.join(project, ".tmp/download-storage-reliability-"));
    const database = path.join(directory, "downloads.sqlite3");
    const initial = new MediaHost();
    try {
      await initial.start(database);
      await initial.request("hello");
    } finally {
      await initial.close();
    }
    const base = createDownloadTasks(
      { urls: ["https://example.invalid/video.mp4"], directory, kind: "auto", headers: {} },
      [],
    )[0]!;
    const expected: DownloadTask[] = [];
    const seed = new DatabaseSync(database);
    try {
      seed.exec("BEGIN");
      const insert = seed.prepare("INSERT INTO download_tasks(id,revision,payload) VALUES(?,?,?)");
      for (let index = 0; index < 1003; index++) {
        const task: DownloadTask = {
          ...base,
          id: String(index).padStart(4, "0"),
          revision: 1,
          status: "cancelled",
          log: index < 3 ? ["x".repeat(420000)] : [],
        };
        insert.run(task.id, task.revision, JSON.stringify(task));
        expected.push(task);
      }
      seed.exec("COMMIT");
    } finally {
      seed.close();
    }
    const host = new MediaHost();
    try {
      await host.start(database);
      const loaded: DownloadTask[] = [];
      let pages = 0;
      for (let offset = 0; ;) {
        const page = await host.request<{ tasks: DownloadTask[]; nextOffset: number | null }>(
          "downloads.load",
          { offset },
        );
        expect(page.tasks.length).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(JSON.stringify(page.tasks))).toBeLessThan(1024 * 1024 + 1024);
        if (pages++ === 0) expect(page.tasks).toHaveLength(2);
        loaded.push(...page.tasks);
        if (page.nextOffset === null) break;
        expect(page.nextOffset).toBe(offset + page.tasks.length);
        offset = page.nextOffset;
      }
      expect(loaded).toEqual(expected);
      const newTask = { ...base, revision: 1 };
      await expect(
        host.request("downloads.save", { task: newTask, expectedRevision: 0 }),
      ).rejects.toThrow("1000");
      await host.request("downloads.save", {
        task: { ...expected[0]!, revision: 2, error: "保留记录可修改" },
        expectedRevision: 1,
      });
      for (let index = 0; index < 4; index++)
        await host.request("downloads.remove", {
          id: expected[index]!.id,
          revision: index === 0 ? 2 : 1,
        });
      await host.request("downloads.save", { task: newTask, expectedRevision: 0 });
      const another = { ...newTask, id: crypto.randomUUID() };
      await expect(
        host.request("downloads.save", { task: another, expectedRevision: 0 }),
      ).rejects.toThrow("1000");
    } finally {
      await host.close();
    }
    const verify = new DatabaseSync(database, { readOnly: true });
    try {
      expect(verify.prepare("SELECT count(*) AS count FROM download_tasks").get()!.count).toBe(
        1000,
      );
      expect(verify.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally {
      verify.close();
    }
  }, 30000);
});
