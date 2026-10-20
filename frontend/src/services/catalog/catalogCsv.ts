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
