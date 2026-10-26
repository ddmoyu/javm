import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanMetadataDiagnostics,
  MetadataTrace,
} from "../frontend/src/services/metadata/diagnostics";
import type { MetadataSourceDiagnostic } from "../frontend/src/services/metadata/diagnostics";
import {
  FeedbackService,
  restoreFeedbackState,
} from "../frontend/src/services/feedback/FeedbackService";
import { LogService } from "../frontend/src/services/logging/LogService";
import { setLogSink } from "../frontend/src/services/logging/events";
import { retryMetadata } from "../frontend/src/services/scraping/MetadataPipeline";

afterEach(() => setLogSink());
const parseRow: MetadataSourceDiagnostic = {
  provider: "FANZA",
  category: "parse",
  elapsedMs: 20,
  stage: "parse",
  reason: "missing_page_data",
  httpStatus: 200,
  count: 1,
};
function respond(trace: MetadataTrace, rows: unknown[]) {
  trace.request("v1.4.0", "direct");
  trace.response({ schema: 1, sources: rows }, "MetaTube", 20, 404);
}

describe("Issue 11 来源诊断", () => {
  it("按原因及 HTTP 状态分别合并重试，保留真实空结果与旧组件兼容", () => {
    const trace = new MetadataTrace("search");
    const rows = [
      parseRow,
      { ...parseRow, reason: "invalid_page_data" },
      {
        ...parseRow,
        category: "denied",
        stage: "response",
        reason: "http_status",
        httpStatus: 403,
      },
      {
        ...parseRow,
        category: "denied",
        stage: "response",
        reason: "http_status",
        httpStatus: 401,
      },
      { provider: "Legacy", category: "empty", elapsedMs: 10, results: 0 },
    ];
    respond(trace, rows);
    respond(trace, rows);
    const snapshot = trace.snapshot("failed");
    expect(snapshot.sources).toHaveLength(5);
    expect(snapshot.sources.every((row) => row.count === 2)).toBe(true);
    expect(snapshot.sources[0]).toMatchObject({ ...parseRow, elapsedMs: 40, count: 2 });
    expect(trace.error(404).noResults).toBe(false);
    const empty = new MetadataTrace("search");
    respond(empty, [rows[4]]);
    expect(empty.error(404).noResults).toBe(true);
  });

  it("报告持久化及日志保留安全诊断，不因日志字段上限丢失次数和结果数", async () => {
    const logs = new LogService();
    const reports = new FeedbackService(logs, {
      read: async () => null,
      write: async () => {},
      system: async () => ({ JAVM: "safe-fixture" }),
      copy: async () => {},
      open: async () => {},
    });
    try {
      await reports.initialize();
      setLogSink(logs.record);
      const trace = new MetadataTrace("search", "safe-task");
      respond(trace, [{ ...parseRow, results: 0 }]);
      trace.finish("failed");
      const id = reports.capture({
        module: "metatube",
        title: "安全样例查询失败",
        message: trace.error(404).message,
        taskId: "safe-task",
        metadata: trace.snapshot("failed"),
      })!;
      expect(reports.preview(id)).toContain("失败阶段=parse；原因=missing_page_data；HTTP=200");
      const source = logs.getRecentEntries().find((row) => row.event === "source_result")!;
      expect(source.message).toContain("失败阶段=parse；原因=missing_page_data；HTTP=200");
      expect(source.context).toMatchObject({
        taskId: "safe-task",
        queryId: trace.queryId,
        reason: "missing_page_data",
        elapsedMs: 20,
        attempts: 1,
        results: 0,
      });
      const saved = reports.getSnapshot().reports.find((report) => report.id === id)!;
      const restored = restoreFeedbackState({
        schema: 1,
        session: {
          id: logs.getSession(),
          startedAt: new Date().toISOString(),
          clean: true,
          system: {},
        },
        reports: [saved],
      });
      expect(restored?.reports[0]?.metadata?.sources[0]).toMatchObject(parseRow);
    } finally {
      reports.dispose();
    }
  });

  it("丢弃非白名单诊断和原始响应，限制状态码范围", () => {
    const trace = new MetadataTrace("search");
    respond(trace, [
      {
        ...parseRow,
        stage: "https://example.invalid/private",
        reason: "safe-private-body",
        httpStatus: 999,
        body: "safe-private-body",
        error: "fake-secret",
        url: "https://example.invalid/?token=fake-secret",
      },
      { ...parseRow, httpStatus: "200" },
    ]);
    const snapshot = cleanMetadataDiagnostics(trace.snapshot("failed"))!;
    expect(snapshot.sources[0]).not.toHaveProperty("reason");
    expect(snapshot.sources[0]).not.toHaveProperty("stage");
    expect(snapshot.sources.every((row) => row.httpStatus === undefined)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/safe-private|fake-secret|example\.invalid/);
  });

  it.each([
    ["timeout", "request_failed", "request", 3],
    ["denied", "challenge_page", "response", 1],
    ["parse", "missing_page_data", "parse", 1],
  ] as const)("%s 诊断控制重试且不会被误报为无收录", async (category, reason, stage, calls) => {
    const trace = new MetadataTrace("search");
    const operation = vi.fn(async () => {
      respond(trace, [{ provider: "Fixture", category, reason, stage, elapsedMs: 20 }]);
      throw trace.error(404);
    });
    await expect(
      retryMetadata(operation, 2, new AbortController().signal, async () => {}),
    ).rejects.toMatchObject({ noResults: false });
    expect(operation).toHaveBeenCalledTimes(calls);
  });
});
