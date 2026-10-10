import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import type { MaintenanceVideo, RemovalPlan } from "../frontend/src/contracts/maintenance";
import { healthRows } from "../frontend/src/services/library/maintenanceRules";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("健康检查及普通资源删除（安全虚构文件）", () => {
  let host: MediaHost, root: string;
  beforeAll(async () => {
    await fs.mkdir(".tmp", { recursive: true });
    root = path.resolve(await fs.mkdtemp(".tmp/library-health-"));
    await fs.writeFile(path.join(root, "SAFE-001.mp4"), "safe fake binary; never played");
    const db = createLibraryFixture(path.join(root, "library.sqlite3"));
    db.exec(
      "INSERT INTO works(id,code,code_key,title,favorite) VALUES('work','SAFE-001','safe001','虚构纪录片',1)",
    );
    for (const [id, file] of [
      ["one", "SAFE-001.mp4"],
      ["two", "MISSING-002.mp4"],
    ]) {
      const full = path.join(root, file!);
      db.prepare(
        "INSERT INTO media_files(id,work_id,path_key,path,dir_path,file_size) VALUES(?,'work',?,?,?,?)",
      ).run(id!, full.toLowerCase(), full, root, 30);
    }
    db.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    await host.request("library.status");
  });
  afterAll(async () => {
    await host?.close();
  });
  it("报告缺失资源与资料问题，检查自身不修改数据库", async () => {
    const result = await host.request<{ items: MaintenanceVideo[] }>("library.maintenance.read", {
      health: true,
    });
    expect(result.items.find((row) => row.id === "two")?.issues).toContain("视频文件缺失");
    expect(result.items[0]?.issues).toContain("缺少规范 NFO");
    expect(healthRows(result.items)).toHaveLength(2);
    const unchanged = await host.request<{ items: MaintenanceVideo[] }>("library.maintenance.read");
    expect(unchanged.items.find((row) => row.id === "two")?.missing).toBe(false);
  });
  it("单个视频删除保留同作品的另一资源、资料与收藏", async () => {
    const token = crypto.randomUUID(),
      target = path.join(root, "SAFE-001.mp4");
    const plan = await host.request<RemovalPlan>("library.maintenance.prepare", {
      token,
      id: "one",
      path: target,
      metadataOnly: false,
    });
    expect(plan.files.map((file) => path.resolve(file.path))).toEqual([target]);
    await host.request("library.maintenance.checkFile", { token, path: plan.files[0]!.path });
    await fs.unlink(target);
    await host.request("library.maintenance.complete", { token });
    const work = await host.request<{ favorite: number; media_files: { id: string }[] }>(
      "library.video",
      { id: "work" },
    );
    expect(work.favorite).toBe(1);
    expect(work.media_files).toHaveLength(1);
    expect(work.media_files[0]?.id).toBe("two");
  });
});
