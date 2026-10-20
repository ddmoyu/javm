import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { javbusKinds, serializeJavbusCsv } from "../../frontend/src/services/catalog/javbusCatalog";
import type {
  JavbusCatalogDimension,
  JavbusCatalogEntry,
} from "../../frontend/src/services/catalog/javbusCatalog";

export async function safeCatalogSeed(directory: string) {
  const now = Date.now() - 1000;
  const entries: JavbusCatalogEntry[] = Array.from({ length: 125 }, (_, i) => ({
    dimension: "actresses",
    lane: "censored",
    id: `safe-${i}`,
    name: `安全演员${i}`,
    label: `安全演员${i}`,
    aliases: [],
    translationStatus: "pending",
    category: "",
    videoCount: i,
    countUpdatedAt: now,
  }));
  entries[0] = {
    ...entries[0]!,
    label: "安全译名",
    aliases: ["安全别名"],
    translationStatus: "reviewed",
  };
  entries.push({ ...entries[1]!, lane: "uncensored", videoCount: 10 });
  entries.push({ ...entries[2]!, id: "safe-other", lane: "uncensored", videoCount: 20 });
  entries.push({
    ...entries[3]!,
    id: "safe-missing",
    name: "安全未知演员",
    label: "安全未知演员",
    videoCount: undefined,
    countUpdatedAt: undefined,
  });
  entries.push({
    ...entries[4]!,
    dimension: "studios",
    id: "safe-studio",
    name: "安全制作商",
    label: "安全制作商",
    videoCount: undefined,
    countUpdatedAt: undefined,
  });
  const files: Record<JavbusCatalogDimension, string> = {
    actresses: "actresses.csv",
    maleActors: "male-actors.csv",
    directors: "directors.csv",
    studios: "studios.csv",
    labels: "labels.csv",
    series: "series.csv",
    genres: "genres.csv",
  };
  await fs.mkdir(directory, { recursive: true });
  for (const dimension of Object.keys(javbusKinds) as JavbusCatalogDimension[])
    await fs.writeFile(
      path.join(directory, files[dimension]),
      serializeJavbusCsv(
        entries.filter((e) => e.dimension === dimension),
        now,
      ),
    );
  const filename = path.join(directory, "catalog.sqlite3");
  const builder = pathToFileURL(
    fileURLToPath(new URL("../../scripts/build-catalog-seed.mjs", import.meta.url)),
  ).href;
  await promisify(execFile)(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const { buildCatalogSeed } = await import(${JSON.stringify(builder)}); await buildCatalogSeed(process.argv[1],process.argv[2]);`,
      directory,
      filename,
    ],
    { windowsHide: true },
  );
  return {
    filename,
    entries: entries.filter((e) => e.dimension !== "actresses" || e.videoCount !== undefined),
  };
}
