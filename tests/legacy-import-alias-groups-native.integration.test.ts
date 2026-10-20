import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const schema = await fs.readFile(path.join(project, "tests/fixtures/legacy-v2.sql"), "utf8");

describe.runIf(enabled)("旧版扩展分组以原始记录归档", () => {
  const hosts: MediaHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });
  async function fixture(extra: string) {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(project, ".tmp/legacy-alias-"));
    const source = path.join(root, "com.ddmoyu.javm/javm.db");
    await fs.mkdir(path.dirname(source));
    const db = new DatabaseSync(source);
    db.exec(schema);
    db.exec(extra);
    db.close();
    return { root, source, target: path.join(root, "JAVM/library.sqlite3") };
  }
  async function hostAt(root: string) {
    const host = new MediaHost();
    hosts.push(host);
    await host.start(path.join(root, "JAVM/downloads-v1.sqlite3"));
    return host;
  }
  async function importInto(host: MediaHost) {
    await host.request("library.legacy.check");
    await host.request("library.legacy.start");
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await host.request<LegacyImportSnapshot>("library.legacy.status");
      if (state.state !== "running") return state;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("导入任务超时");
  }
  it("厂商和演员表为空时仍保留独立别名分组及其番号关联", async () => {
    const { root, source, target } = await fixture(`
      INSERT INTO entity_aliases(id,entity_type,entity_id,name,name_norm,is_canonical) VALUES
        (1,'studio',27,'合成厂商','studio-a',1),(2,'studio',27,'合成别名','studio-b',0),
        (3,'actor',52,'合成演员','actor-a',1),(4,'tag',49,'合成标签','tag-a',1);
      INSERT INTO designation_entities VALUES('SYNTH-001','studio',27),('SYNTH-001','actor',52);
    `);
    const host = await hostAt(root);
    expect(await importInto(host)).toMatchObject({ state: "completed" });
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) n FROM entities").get()?.n).toBe(0);
      expect(
        db.prepare("SELECT count(*) n FROM legacy_records WHERE table_name='entity_aliases'").get()
          ?.n,
      ).toBe(4);
      expect(
        db
          .prepare("SELECT count(*) n FROM legacy_records WHERE table_name='designation_entities'")
          .get()?.n,
      ).toBe(2);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('entity_aliases','designation_entities')",
          )
          .all(),
      ).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    await expect(fs.stat(source)).rejects.toThrow();
  });
});
