export const avwikiSources = {
  actresses: "https://avwikidb.com/actor/",
  maleActors: "https://avwikidb.com/histrion/",
  directors: "https://avwikidb.com/director/",
  studios: "https://avwikidb.com/maker/",
  series: "https://avwikidb.com/series/",
} as const;
export type AvwikiDimension = keyof typeof avwikiSources;
export const isAvwikiDimension = (value: string): value is AvwikiDimension =>
  Object.hasOwn(avwikiSources, value);
export const csvColumns = [
  "source",
  "kind",
  "source_id",
  "name_original",
  "name_zh",
  "aliases",
  "translation_status",
  "source_url",
] as const;
export interface AvwikiEntry {
  id: string;
  name: string;
  label: string;
  aliases: string[];
}
export const hasControlCharacters = (value: string) => {
  for (let i = 0; i < value.length; i++)
    if (value.charCodeAt(i) < 32 || value.charCodeAt(i) === 127) return true;
  return false;
};
// 在 Worker 中运行；保留引号、逗号与换行，不把 CSV 当成 HTML。
export function parseCatalogCsvRows(csv: string): string[][] {
  const fail = () => {
    throw new Error("内置目录 CSV 无效，请重新安装。");
  };
  if (csv.length > 16 * 1024 * 1024) fail();
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const source = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === '"' && !field && !closed) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (char !== ",") {
        if (char === "\r" && source[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
        if (rows.length > 100_001) fail();
      }
    } else if (closed || char === '"') fail();
    else field += char;
  }
  if (quoted) fail();
  if (field || row.length || closed) rows.push([...row, field]);
  return rows;
}
export function parseAvwikiCsv(csv: string, dimension: AvwikiDimension): AvwikiEntry[] {
  const fail = () => {
    throw new Error("内置目录 CSV 无效，请重新安装。");
  };
  const rows = parseCatalogCsvRows(csv);
  if (rows.shift()?.join(",") !== csvColumns.join(",") || !rows.length) fail();
  const kind = new URL(avwikiSources[dimension]).pathname.split("/")[1]!;
  const ids = new Set<string>();
  return rows.map((values) => {
    const [origin, type, id, original, chinese, aliases, status, url] = values;
    const valid = (name: string | undefined) =>
      typeof name === "string" &&
      !!name &&
      name.trim() === name &&
      name.length <= 128 &&
      !hasControlCharacters(name);
    if (
      values.length !== 8 ||
      origin !== "avwikidb" ||
      type !== kind ||
      !id ||
      !/^[a-z]?\d+$/.test(id) ||
      ids.has(id) ||
      !valid(original) ||
      (chinese && !valid(chinese)) ||
      !["pending", "translated", "reviewed"].includes(status!) ||
      url !== `${avwikiSources[dimension]}${id}/`
    )
      fail();
    ids.add(id!);
    const alternatives = aliases ? aliases.split("|").map((value) => value.trim()) : [];
    if (alternatives.length > 32 || alternatives.some((name) => !valid(name))) fail();
    return { id: id!, name: original!, label: chinese || original!, aliases: alternatives };
  });
}
