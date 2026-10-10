import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { MediaHost } from "./helpers/mediaHost";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";

describe.runIf(enabled)("旧库探测与当前库启动独立", () => {
  const hosts: MediaHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });
  async function fixture() {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(project, ".tmp/legacy-reopen-"));
    const source = path.join(root, "com.ddmoyu.javm/javm.db");
    const target = path.join(root, "JAVM/library.sqlite3");
    await fs.mkdir(path.dirname(source));
    await fs.mkdir(path.dirname(target));
    const old = new DatabaseSync(source);
    old.exec(await fs.readFile(path.join(project, "tests/fixtures/legacy-0.5.3.sql"), "utf8"));
    old.close();
    return { root, source, target };
  }
  async function start(root: string) {
    const host = new MediaHost();
    hosts.push(host);
    await host.start(path.join(root, "JAVM/downloads-v1.sqlite3"));
    return host;
  }
  it("只探测旧库不创建当前库，跳过后当前库仍可正常初始化和查询", async () => {
    const { root, target, source } = await fixture();
    const original = await fs.readFile(source);
    const host = await start(root);
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe(
      "available",
    );
    await expect(fs.stat(target)).rejects.toThrow();
    await host.request("library.status");
    expect(await host.request("library.summary")).toMatchObject({ total: 0 });
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe(
      "available",
    );
    expect(await fs.readFile(source)).toEqual(original);
  });
  it("当前库版本不支持时仍能发现旧库，失败的启动不会使状态查询卡住", async () => {
    const { root, target } = await fixture();
    const db = new DatabaseSync(target);
    db.exec(
      "CREATE TABLE retained(id INTEGER); INSERT INTO retained VALUES(1); PRAGMA user_version=99",
    );
    db.close();
    const original = await fs.readFile(target);
    const host = await start(root);
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe(
      "available",
    );
    await expect(host.request("library.legacy.start")).rejects.toThrow("这不是 JAVM 1.0 片库");
    expect(await host.request("library.legacy.status")).toMatchObject({ state: "unchecked" });
    expect(await fs.readFile(target)).toEqual(original);
  });
  it("当前库存在未使用的异常页时指明当前库及路径，保留原文件且仍可重新检查旧库", async () => {
    const { root, target } = await fixture();
    createLibraryFixture(target).close();
    const bytes = await fs.readFile(target);
    const pageSize = bytes.readUInt16BE(16) || 65536;
    const corrupt = Buffer.concat([bytes, Buffer.alloc(pageSize * 2)]);
    corrupt.writeUInt32BE(corrupt.length / pageSize, 28);
    await fs.writeFile(target, corrupt);
    const host = await start(root);
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe(
      "available",
    );
    await expect(host.request("library.status")).rejects.toThrow("当前片库完整性检查失败");
    await expect(host.request("library.status")).rejects.toThrow("never used");
    expect(await host.request("library.legacy.status")).toMatchObject({ state: "unchecked" });
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe(
      "available",
    );
    expect(await fs.readFile(target)).toEqual(corrupt);
  });
});
