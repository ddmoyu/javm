import { readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// 复用运行时校验器；仅构建时读取采集快照，不访问网站，也不输出记录内容。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === "ERR_MODULE_NOT_FOUND" &&
        /^\.\.?\//.test(specifier) &&
        !path.extname(specifier)
      )
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { parseJavbusCsv } = await import("../frontend/src/services/catalog/javbusCatalog.ts");
hooks.deregister();

export const catalogApplicationId = 0x4a434154;
export const catalogFiles = {
  actresses: "actresses.csv",
  maleActors: "male-actors.csv",
  directors: "directors.csv",
  studios: "studios.csv",
  labels: "labels.csv",
  series: "series.csv",
  genres: "genres.csv",
};
const dimensions = Object.keys(catalogFiles);
const statuses = ["pending", "translated", "reviewed"];

export async function buildCatalogSeed(input, output, now = Date.now()) {
  const inventory = [];
  const records = [];
  let inputBytes = 0;
  for (const [dimension, filename] of Object.entries(catalogFiles)) {
    const file = path.join(input, filename);
    inputBytes += (await stat(file)).size;
    if (inputBytes > 16 * 1024 * 1024) throw new Error("目录源文件超过大小限制。");
    const csv = await readFile(file, "utf8");
    const entries = parseJavbusCsv(csv, dimension, now);
    const kept = entries.filter(
      (entry) => !["actresses", "maleActors"].includes(dimension) || entry.videoCount !== undefined,
    );
    if (records.length + kept.length > 100_000) throw new Error("内置目录数量超过限制。");
    inventory.push({
      dimension,
      sourceRows: entries.length,
      rows: kept.length,
      removed: entries.length - kept.length,
      sourceSha256: createHash("sha256").update(csv).digest("hex"),
    });
    for (let position = 0; position < kept.length; position++)
      records.push({ ...kept[position], position });
  }
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let db;
  try {
    db = new DatabaseSync(temporary);
    db.exec(`PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA application_id=${catalogApplicationId}; PRAGMA user_version=1;
      CREATE TABLE catalog(id INTEGER PRIMARY KEY, dimension INTEGER NOT NULL, source_position INTEGER NOT NULL,
        lane INTEGER NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL, label TEXT, aliases TEXT,
        translation_status INTEGER NOT NULL, category TEXT, video_count INTEGER, count_updated_at INTEGER);
      BEGIN IMMEDIATE;`);
    const insert = db.prepare("INSERT INTO catalog VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < records.length; i++) {
      const entry = records[i];
      insert.run(
        i + 1,
        dimensions.indexOf(entry.dimension) + 1,
        entry.position,
        entry.lane === "uncensored" ? 1 : 0,
        entry.id,
        entry.name,
        entry.label === entry.name ? null : entry.label,
        entry.aliases.length ? JSON.stringify(entry.aliases) : null,
        statuses.indexOf(entry.translationStatus),
        entry.category || null,
        entry.videoCount ?? null,
        entry.countUpdatedAt ?? null,
      );
    }
    const dimensionSql = `CASE dimension ${dimensions.map((d, i) => `WHEN ${i + 1} THEN '${d}'`).join(" ")} END`;
    db.exec(`CREATE UNIQUE INDEX catalog_identity ON catalog(dimension,lane,source_id);
      CREATE INDEX catalog_source ON catalog(dimension,source_position);
      CREATE INDEX catalog_name ON catalog(dimension,name);
      CREATE VIEW names AS SELECT ${dimensionSql} AS dimension,name,
        ROW_NUMBER() OVER(PARTITION BY dimension ORDER BY first_position)-1 AS position,video_count
        FROM (SELECT dimension,name,MIN(lane*100000+source_position) AS first_position,
          CASE WHEN COUNT(DISTINCT source_id)=1 AND COUNT(video_count)=COUNT(*) AND SUM(video_count)<=100000000
            THEN SUM(video_count) ELSE NULL END AS video_count FROM catalog GROUP BY dimension,name);
      COMMIT; VACUUM; ANALYZE;`);
    if (
      db.prepare("PRAGMA quick_check").get().quick_check !== "ok" ||
      db
        .prepare(
          "SELECT count(*) AS n FROM catalog WHERE dimension IN (1,2) AND video_count IS NULL",
        )
        .get().n !== 0
    )
      throw new Error("内置目录校验失败。");
    db.close();
    db = undefined;
    const bytes = await readFile(temporary);
    const manifest = {
      version: 1,
      applicationId: catalogApplicationId,
      rows: records.length,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      inventory,
    };
    await rename(temporary, output);
    await writeFile(`${output}.json`, JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } finally {
    db?.close();
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const input = path.join(root, "data/catalogs/javbus");
  const result = await buildCatalogSeed(input, path.join(input, "catalog.sqlite3"));
  console.log(
    JSON.stringify(
      {
        rows: result.rows,
        bytes: result.bytes,
        sha256: result.sha256,
        inventory: result.inventory.map(({ dimension, sourceRows, rows, removed }) => ({
          dimension,
          sourceRows,
          rows,
          removed,
        })),
      },
      null,
      2,
    ),
  );
}
