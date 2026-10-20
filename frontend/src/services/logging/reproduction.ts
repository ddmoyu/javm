import { diagnosticUrl, redactText } from "./sanitize";

// 与短计数 context 分开，避免番号、路径及长链接被 160 字符限制截断。
export interface ReproductionContext {
  action?: string;
  code?: string;
  query?: string;
  source?: string;
  sourceId?: string;
  dimension?: string;
  page?: number;
  pageUrl?: string;
  requestUrl?: string;
  mediaUrl?: string;
  filePath?: string;
}
const textLimits = {
  action: 80,
  code: 120,
  query: 500,
  source: 120,
  sourceId: 500,
  dimension: 80,
  filePath: 4096,
} as const;
const urlFields = ["pageUrl", "requestUrl", "mediaUrl"] as const;
export function cleanReproduction(value: unknown): ReproductionContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const result: ReproductionContext = {};
  for (const [key, limit] of Object.entries(textLimits)) {
    const text = input[key];
    if (typeof text === "string" && text.trim())
      result[key as keyof typeof textLimits] = redactText(text, limit);
  }
  if (typeof input.page === "number" && Number.isSafeInteger(input.page) && input.page > 0)
    result.page = input.page;
  for (const key of urlFields)
    if (typeof input[key] === "string" && input[key]) result[key] = diagnosticUrl(input[key]);
  return Object.keys(result).length ? result : undefined;
}

const labels: Record<keyof ReproductionContext, string> = {
  action: "操作",
  code: "番号",
  query: "查询内容",
  source: "来源",
  sourceId: "来源条目 ID",
  dimension: "查询维度",
  page: "请求页码",
  pageUrl: "来源页面",
  requestUrl: "请求地址",
  mediaUrl: "视频链接",
  filePath: "文件路径",
};
export function reproductionText(value: ReproductionContext) {
  return Object.entries(cleanReproduction(value) ?? {})
    .map(([key, item]) => `${labels[key as keyof ReproductionContext]}: ${item}`)
    .join("\n");
}
