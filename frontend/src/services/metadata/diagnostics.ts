import { logEvent } from "../logging/events";
import { reportFailure } from "../feedback/events";
import { JsonHttpError } from "./shared";
import { StopUnconfirmedError } from "../downloads/ports";
import { cleanReproduction } from "../logging/reproduction";
import type { ReproductionContext } from "../logging/reproduction";

export const metadataCategories = [
  "found",
  "empty",
  "skipped",
  "denied",
  "rate_limited",
  "tls",
  "dns",
  "timeout",
  "network",
  "parse",
  "incomplete",
  "upstream",
  "service",
  "unknown",
] as const;
export type MetadataCategory = (typeof metadataCategories)[number];
export type MetadataNetwork =
  | "direct"
  | "proxy/http"
  | "proxy/https"
  | "proxy/socks5"
  | "proxy/socks5h"
  | "unknown";
export interface MetadataSourceDiagnostic {
  provider: string;
  category: MetadataCategory;
  elapsedMs: number;
  results?: number;
  missingFields?: string[];
  count: number;
}
export interface MetadataDiagnostics {
  schema: 1;
  queryId: string;
  operation: "search" | "details";
  version: string;
  network: MetadataNetwork;
  networks: MetadataNetwork[];
  attempts: number;
  elapsedMs: number;
  outcome: "completed" | "failed" | "cancelled";
  detailed: boolean;
  omitted: number;
  sources: MetadataSourceDiagnostic[];
}
export interface MetadataQueryOptions {
  refresh?: boolean;
  taskId?: string;
  trace?: MetadataTrace;
}
const fields = new Set(["id", "number", "title", "cover_url", "provider", "homepage", "metadata"]);
const networks = new Set<MetadataNetwork>([
  "direct",
  "proxy/http",
  "proxy/https",
  "proxy/socks5",
  "proxy/socks5h",
  "unknown",
]);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const integer = (value: unknown, max = 86400000) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
function source(value: unknown): MetadataSourceDiagnostic | undefined {
  const row = object(value);
  if (
    typeof row.provider !== "string" ||
    !/^[A-Za-z0-9_.-]{1,40}$/.test(row.provider) ||
    !metadataCategories.includes(row.category as MetadataCategory) ||
    !integer(row.elapsedMs)
  )
    return;
  return {
    provider: row.provider,
    category: row.category as MetadataCategory,
    elapsedMs: row.elapsedMs as number,
    ...(integer(row.results, 1000000) ? { results: row.results as number } : {}),
    ...(Array.isArray(row.missingFields)
      ? {
          missingFields: [
            ...new Set(
              row.missingFields
                .slice(0, 16)
                .filter((field): field is string => typeof field === "string" && fields.has(field)),
            ),
          ].slice(0, fields.size),
        }
      : {}),
    count: integer(row.count, 10000) && row.count !== 0 ? (row.count as number) : 1,
  };
}
/** Only the fixed diagnostic schema crosses into logs/reports, never response text or metadata. */
export function cleanMetadataDiagnostics(value: unknown): MetadataDiagnostics | undefined {
  const row = object(value);
  if (
    row.schema !== 1 ||
    typeof row.queryId !== "string" ||
    !/^[\w-]{1,100}$/.test(row.queryId) ||
    !["search", "details"].includes(String(row.operation)) ||
    !Array.isArray(row.sources)
  )
    return;
  const sources = row.sources
    .slice(0, 64)
    .map(source)
    .filter((item) => !!item);
  return {
    schema: 1,
    queryId: row.queryId,
    operation: row.operation as MetadataDiagnostics["operation"],
    version:
      typeof row.version === "string" &&
      row.version.length <= 80 &&
      /^v[\d.]+(?:-[\w.-]+)?$/.test(row.version)
        ? row.version
        : "unknown",
    network: networks.has(row.network as MetadataNetwork)
      ? (row.network as MetadataNetwork)
      : "unknown",
    networks: Array.isArray(row.networks)
      ? [
          ...new Set(
            row.networks.slice(0, 6).filter((item): item is MetadataNetwork => networks.has(item)),
          ),
        ]
      : ["unknown"],
    attempts: integer(row.attempts, 10000) ? (row.attempts as number) : 0,
    elapsedMs: integer(row.elapsedMs) ? (row.elapsedMs as number) : 0,
    outcome: row.outcome === "completed" || row.outcome === "cancelled" ? row.outcome : "failed",
    detailed: row.detailed === true,
    omitted: Math.min(
      10000,
      (integer(row.omitted, 10000) ? (row.omitted as number) : 0) +
        row.sources.length -
        sources.length,
    ),
    sources,
  };
}
export function metadataNetwork(proxy: string): MetadataNetwork {
  if (!proxy) return "direct";
  try {
    const value = `proxy/${new URL(proxy).protocol.slice(0, -1)}` as MetadataNetwork;
    return networks.has(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}
export const metadataMessages = {
  empty: "没有找到匹配的资料，请核对编号或更换资料服务。",
  unavailable: "未找到可用资料；当前组件未提供详细原因，请核对编号或稍后重试。",
  denied: "资料服务拒绝访问，可能存在访问限制，请稍后重试或更换服务。",
  rate_limited: "资料请求过于频繁，请稍后重试。",
  tls: "资料服务证书校验失败，请检查网络环境或稍后重试。",
  dns: "资料服务域名解析失败，请检查网络与应用内代理设置。",
  timeout: "资料请求超时，请检查网络或稍后重试。",
  network: "资料服务连接失败，请检查网络与应用内代理设置。",
  parse: "资料页面解析失败，请稍后重试或更换资料服务。",
  incomplete: "资料服务返回的信息不完整，请更换资料服务或稍后重试。",
  upstream: "资料服务暂时异常，请稍后重试。",
  service: "内置资料服务连接失败，请稍后重试或重新启动应用。",
  mixed: "未取得有效资料，部分资料服务访问或解析失败。请查看故障报告。",
  unknown: "资料查询失败，请稍后重试或查看故障报告。",
};
const failed = (category: MetadataCategory) => !["found", "empty", "skipped"].includes(category);
export class MetadataQueryError extends JsonHttpError {
  declare diagnostics?: MetadataDiagnostics;
  constructor(
    status: number,
    message: string,
    readonly retryable: boolean,
    readonly noResults = false,
  ) {
    super(status, message);
    this.name = "MetadataQueryError";
  }
}
export class MetadataTrace {
  reproduction?: ReproductionContext;
  identify(value?: ReproductionContext) {
    this.reproduction = cleanReproduction({ ...value, ...this.reproduction });
  }
  readonly queryId = crypto.randomUUID();
  private started = Date.now();
  private requestStarted = this.started;
  private version = "unknown";
  private network: MetadataNetwork = "unknown";
  private networks = new Set<MetadataNetwork>();
  private attempts = 0;
  private detailed = true;
  private omitted = 0;
  private rows = new Map<string, MetadataSourceDiagnostic>();
  constructor(
    readonly operation: MetadataDiagnostics["operation"],
    readonly taskId?: string,
  ) {}
  request(version: string, network: MetadataNetwork) {
    this.requestStarted = Date.now();
    this.version = version;
    this.network = network;
    this.networks.add(network);
    this.attempts++;
  }
  timeout() {
    this.add({
      provider: "MetaTube",
      category: "timeout",
      elapsedMs: Math.max(0, Date.now() - this.requestStarted),
      count: 1,
    });
    this.detailed = false; // 截止时未取得逐来源响应，只知道本地等待超时。
  }
  response(value: unknown, provider: string, elapsedMs: number, status: number, results?: number) {
    const data = object(value);
    if (data.schema === 1 && Array.isArray(data.sources)) {
      const rows = data.sources
        .slice(0, 64)
        .map(source)
        .filter((item) => !!item);
      this.omitted += data.sources.length - rows.length;
      if (integer(data.omitted, 10000)) this.omitted += data.omitted as number;
      if (rows.length) {
        for (const row of rows) this.add(row);
        return;
      }
    }
    this.detailed = false;
    this.add({
      provider: /^[\w.-]{1,40}$/.test(provider) ? provider : "MetaTube",
      category:
        status === 401 || status === 403
          ? "denied"
          : status === 429
            ? "rate_limited"
            : status === 408 || status === 504
              ? "timeout"
              : status >= 500
                ? "upstream"
                : status >= 200 && status < 300 && results !== undefined
                  ? results > 0
                    ? "found"
                    : "empty"
                  : "unknown",
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      ...(results === undefined ? {} : { results }),
      count: 1,
    });
  }
  private add(row: MetadataSourceDiagnostic) {
    const key = `${row.provider}:${row.category}:${row.missingFields?.join(",") ?? ""}`;
    const old = this.rows.get(key);
    if (old) {
      old.count = Math.min(10000, old.count + 1);
      old.elapsedMs = Math.min(86400000, old.elapsedMs + row.elapsedMs);
      if (row.results !== undefined) old.results = row.results; // latest result count, not a sum across retries
    } else if (this.rows.size < 64) this.rows.set(key, { ...row, count: 1 });
    else this.omitted++;
  }
  error(status: number) {
    const categories = [
      ...new Set([...this.rows.values()].map((row) => row.category).filter(failed)),
    ];
    const noResults =
      status === 404 &&
      this.detailed &&
      this.omitted === 0 &&
      this.attempts > 0 &&
      categories.length === 0;
    const category =
      categories.length === 1
        ? categories[0]!
        : categories.length > 1
          ? "mixed"
          : status === 404
            ? "empty"
            : "unknown";
    const message =
      status === 404 && !this.detailed && categories.every((item) => item === "unknown")
        ? metadataMessages.unavailable
        : metadataMessages[category === "found" || category === "skipped" ? "empty" : category];
    return new MetadataQueryError(
      status,
      message,
      categories.some((item) =>
        ["network", "dns", "timeout", "rate_limited", "upstream", "service"].includes(item),
      ),
      noResults,
    );
  }
  snapshot(outcome: MetadataDiagnostics["outcome"]): MetadataDiagnostics {
    return cleanMetadataDiagnostics({
      schema: 1,
      queryId: this.queryId,
      operation: this.operation,
      version: this.version,
      network: this.network,
      networks: [...this.networks],
      attempts: this.attempts,
      elapsedMs: Date.now() - this.started,
      outcome,
      detailed: this.detailed && this.omitted === 0 && this.attempts > 0,
      omitted: this.omitted,
      sources: [...this.rows.values()],
    })!;
  }
  finish(outcome: MetadataDiagnostics["outcome"]) {
    const diagnostic = this.snapshot(outcome);
    const context = { ...(this.taskId ? { taskId: this.taskId } : {}), queryId: this.queryId };
    for (const row of diagnostic.sources.filter((item) => item.category !== "skipped")) {
      logEvent(
        failed(row.category) ? "warn" : "info",
        "metatube",
        "source_result",
        `资料来源 ${row.provider}：${row.category}${row.missingFields?.length ? `；缺少字段 ${row.missingFields.join(", ")}` : ""}`,
        {
          ...context,
          provider: row.provider,
          category: row.category,
          elapsedMs: row.elapsedMs,
          attempts: row.count,
          ...(row.results === undefined ? {} : { results: row.results }),
        },
      );
    }
    const counts: Record<string, number> = {};
    for (const row of diagnostic.sources)
      counts[row.category] = (counts[row.category] ?? 0) + row.count;
    logEvent(
      outcome === "failed" ? "warn" : "info",
      "metatube",
      "query_summary",
      `资料查询${outcome === "completed" ? "完成" : outcome === "cancelled" ? "已取消" : "失败"}；来源统计 ${JSON.stringify(counts)}${diagnostic.omitted ? `；省略 ${diagnostic.omitted} 项` : ""}`,
      {
        ...context,
        operation: this.operation,
        version: diagnostic.version,
        network: diagnostic.network,
        attempts: diagnostic.attempts,
        elapsedMs: diagnostic.elapsedMs,
        detailed: diagnostic.detailed,
      },
      this.reproduction,
    );
    return diagnostic;
  }
}
export async function withMetadataTrace<T>(
  operation: MetadataDiagnostics["operation"],
  options: MetadataQueryOptions | undefined,
  signal: AbortSignal | undefined,
  run: (options: MetadataQueryOptions & { trace: MetadataTrace }) => Promise<T>,
  reproduction?: ReproductionContext,
): Promise<T> {
  const owner = !options?.trace;
  const trace = options?.trace ?? new MetadataTrace(operation, options?.taskId);
  trace.identify(reproduction);
  let outcome: MetadataDiagnostics["outcome"] = "completed";
  let failure: unknown;
  try {
    return await run({ ...options, trace });
  } catch (error) {
    const timedOut =
      (error instanceof Error && error.name === "TimeoutError") ||
      (signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError");
    if (owner && timedOut && !(error instanceof StopUnconfirmedError)) {
      trace.timeout();
      failure = new MetadataQueryError(408, metadataMessages.timeout, true);
      outcome = "failed";
      throw failure;
    }
    outcome =
      signal?.aborted || (error instanceof Error && error.name === "AbortError")
        ? "cancelled"
        : "failed";
    failure = error;
    throw error;
  } finally {
    if (owner) {
      const diagnostic = trace.finish(outcome);
      if (failure instanceof MetadataQueryError) failure.diagnostics = diagnostic;
      if (
        !options?.taskId &&
        outcome === "failed" &&
        failure instanceof MetadataQueryError &&
        !failure.noResults
      )
        reportFailure({
          module: "metatube",
          title: "资料查询失败",
          message: failure.message,
          details: { queryId: trace.queryId },
          metadata: diagnostic,
          reproduction: trace.reproduction,
        });
    }
  }
}
