export type MagnetSourceId = "btdig" | "btdirectory";

export interface MagnetResource {
  id: string;
  identities: string[];
  magnet: string;
  title: string;
  sizeBytes?: number;
  files?: number;
  seeders?: number;
  date?: string;
  sources: MagnetSourceId[];
}

export interface MagnetPage {
  rows: MagnetResource[];
  hasMore: boolean;
}

export const magnetLimits = {
  bytes: 1024 * 1024,
  pageRows: 60,
  initialSourceRows: 20,
  rows: 200,
  pages: 3,
  sourceMs: 25_000,
} as const;

export const magnetSources: readonly { id: MagnetSourceId; name: string }[] = [
  { id: "btdig", name: "BTDig" },
  { id: "btdirectory", name: "BT 目录" },
];

export function magnetQuery(raw: string) {
  const query = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  // oxlint-disable-next-line no-control-regex -- 查询不能携带控制字符。
  if (!query || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query))
    throw new Error("请输入 1～120 个字符的番号或关键词。");
  return query;
}

export function magnetSearchUrl(source: MagnetSourceId, query: string, page: number) {
  if (!Number.isInteger(page) || page < 1 || page > magnetLimits.pages)
    throw new Error("搜索页数超出限制。");
  const value = magnetQuery(query);
  if (source === "btdig") {
    const url = new URL("https://www.btdig.com/search");
    url.searchParams.set("q", value);
    url.searchParams.set("order", "0");
    url.searchParams.set("p", String(page - 1));
    return url.href;
  }
  if (source !== "btdirectory" || page !== 1) throw new Error("搜索服务不支持此页。");
  const url = new URL("https://btmulu.live/search.html");
  url.searchParams.set("name", value);
  return url.href;
}
