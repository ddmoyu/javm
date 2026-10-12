import { validJavbusEntry } from "./javbusCatalog";
import type { JavbusCatalogEntry } from "./javbusCatalog";

let entries: JavbusCatalogEntry[] | undefined;
let complete = false;
// SQLite 由官方 Extension 分页读取；这里运行在 Worker 内，仅保留名称定位所需记录。
export function appendJavbusSeed(batch: JavbusCatalogEntry[], reset: boolean, done: boolean) {
  if (reset) {
    entries = [];
    complete = false;
  }
  if (
    !entries ||
    complete ||
    batch.length > 500 ||
    entries.length + batch.length > 100_000 ||
    batch.some((entry) => !validJavbusEntry(entry, Date.now()))
  )
    throw new Error("内置 SQLite 目录批次无效。");
  for (const entry of batch) entries.push(entry);
  complete = done;
}
export async function loadJavbusSeed(): Promise<JavbusCatalogEntry[]> {
  if (import.meta.env.DEV)
    return (
      [
        ["actresses", "示例女演员甲"],
        ["studios", "示例制作商甲"],
        ["labels", "示例发行商甲"],
      ] as const
    ).map(([dimension, name]) => ({
      dimension,
      lane: "censored",
      id: "safe-1",
      name,
      label: name,
      aliases: [],
      translationStatus: "pending",
      category: "",
      videoCount: 10,
      countUpdatedAt: 1,
    }));
  if (!entries || !complete) throw new Error("内置 SQLite 目录尚未就绪，请重试。");
  return entries;
}
