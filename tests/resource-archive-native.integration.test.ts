import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import type { SavedResource } from "../frontend/src/services/streamResolution/archive";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("资源归档数据库（安全虚构数据）", () => {
  let host: MediaHost, database: string;
  const record = {
    code: "SAFE-001",
    sourceId: "safe",
    sourceName: "虚构来源",
    stream: {
      manifestUrl: "https://safe.example.invalid/a.m3u8",
      pageUrl: "https://safe.example.invalid/player",
      tracks: [],
      context: {
        headers: { cookie: "fixture-only" },
        publicHeaders: { referer: "https://safe.example.invalid/player" },
      },
      checkedAt: 1,
      expiresAt: 2,
    },
  };
  const start = async () => {
    host = new MediaHost();
    await host.start(database);
    await host.request("library.status");
  };
  const read = (workId?: string) =>
    host.request<SavedResource[]>("library.resources.read", { code: "safe_001", workId });
  beforeAll(async () => {
    await fs.mkdir(".tmp", { recursive: true });
    const root = path.resolve(await fs.mkdtemp(".tmp/resource-archive-"));
    database = path.join(root, "downloads.sqlite3");
    const db = createLibraryFixture(path.join(root, "library.sqlite3"));
    db.exec(
      "INSERT INTO works(id,code,code_key,title) VALUES('work-safe','SAFE-001','safe001','虚构纪录片')",
    );
    db.close();
    await start();
  });
  afterAll(async () => {
    await host?.close();
  });
  it("旧的 1.0 数据库增量建表，重启保留候选且按作品优先返回", async () => {
    await host.request("library.resources.save", record);
    await host.request("library.resources.save", { ...record, workId: "work-safe" });
    await host.close();
    await start();
    expect((await read()).length).toBe(1);
    const rows = await read("work-safe");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.workId).toBe("work-safe");
    expect(rows[0]?.stream.context.headers).toEqual({});
    await host.request("library.resources.save", {
      ...record,
      workId: "work-safe",
      sourceName: "虚构来源更新",
    });
    expect((await read("work-safe"))[0]?.id).toBe(rows[0]?.id);
  });
  it("拒绝错误作品关联及私密公开头，移除后不再返回", async () => {
    await expect(
      host.request("library.resources.save", { ...record, code: "SAFE-999", workId: "work-safe" }),
    ).rejects.toThrow();
    await expect(
      host.request("library.resources.save", {
        ...record,
        stream: { ...record.stream, context: { publicHeaders: { authorization: "fixture" } } },
      }),
    ).rejects.toThrow();
    const rows = await read();
    await host.request("library.resources.remove", { id: rows[0]!.id });
    expect(await read()).toEqual([]);
    expect(await read("work-safe")).toHaveLength(1);
  });
});
