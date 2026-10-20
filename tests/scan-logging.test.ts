import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ScanProgress } from "../frontend/src/contracts/library";
import { observeLibraryScan } from "../frontend/src/services/logging/libraryScan";
import { setLogSink } from "../frontend/src/services/logging/events";
import type { LogEntry } from "../frontend/src/services/logging/events";
import { LogService } from "../frontend/src/services/logging/LogService";
import { failureFromLog, logExcerpt } from "../frontend/src/services/feedback/report";

function scan(patch: Partial<ScanProgress> = {}): ScanProgress {
  return {
    id: "safe-scan",
    directoryId: "safe-directory",
    state: "scanning",
    discovered: 0,
    processed: 0,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    current: "",
    issues: [],
    concurrency: 10,
    activeProbes: 0,
    peakProbes: 0,
    warnings: 0,
    notices: [],
    probeTimeoutMs: 15000,
    probeTimeouts: 0,
    elapsedMs: 0,
    storageKind: "fixed",
    errorCounts: {},
    ...patch,
  };
}
function setup() {
  let value: { scan: ScanProgress | null } = { scan: null };
  const listeners = new Set<() => void>();
  const logs = new LogService();
  const reports: { input: NonNullable<ReturnType<typeof failureFromLog>>; before: string }[] = [];
  logs.observeEntries((entry) => {
    const input = failureFromLog(entry);
    if (input) reports.push({ input, before: logExcerpt(logs.getRecentEntries(), input.taskId) });
  });
  setLogSink(logs.record);
  const stop = observeLibraryScan({
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    entries: () => logs.getRecentEntries(),
    reports,
    stop,
    publish(next: ScanProgress | null) {
      value = { scan: next };
      for (const listener of listeners) listener();
    },
  };
}
const terminal = (entries: LogEntry[]) => entries.at(-1)!;
afterEach(() => setLogSink());

describe("扫描结果诊断", () => {
  it("部分完成只生成一份准确的反馈，结果与运行字段经过日志清理后仍完整", () => {
    const run = setup();
    run.publish(scan());
    run.publish(
      scan({
        state: "partial",
        discovered: 2342,
        processed: 2342,
        imported: 2000,
        unchanged: 300,
        skipped: 14,
        errors: 28,
        peakProbes: 10,
        elapsedMs: 307188,
        probeTimeouts: 28,
        errorCounts: { probe: 28 },
        issues: Array.from({ length: 28 }, (_, index) => ({
          path: `C:\\private-library\\safe-video-${index}.mp4`,
          message: "媒体探测超时",
          stage: "probe",
          extension: "mp4",
          sizeBytes: 4_000_000_000,
          elapsedMs: 15015,
        })),
      }),
    );
    expect(run.reports).toHaveLength(1);
    expect(run.reports[0]!.input).toMatchObject({
      title: "扫描部分完成",
      details: {
        taskId: "safe-scan",
        state: "partial",
        discovered: 2342,
        processed: 2342,
        imported: 2000,
        unchanged: 300,
        skipped: 14,
        errors: 28,
      },
    });
    expect(terminal(run.entries()).level).toBe("warn");
    expect(terminal(run.entries()).message).toContain("视频与 NFO");
    expect(run.entries().find((entry) => entry.event === "scan_diagnostics")?.context).toEqual({
      taskId: "safe-scan",
      elapsedMs: 307188,
      concurrency: 10,
      peakProbes: 10,
      probeTimeoutMs: 15000,
      probeTimeouts: 28,
      storageKind: "fixed",
      warnings: 0,
    });
    const report = run.reports[0]!.before;
    expect(report).toContain('"sizeBytes":4000000000');
    expect(report).toContain('"elapsedMs":15015');
    expect(report).toContain('"probeTimeouts":28');
    for (let index = 0; index < 28; index++) expect(report).toContain(`safe-video-${index}.mp4`);
    expect(report).toContain("private-library");
  });

  it("样本截断不改变全部错误统计，保留文件和原因但过滤用户名及凭据", () => {
    const run = setup();
    run.publish(
      scan({
        state: "partial",
        errors: 81,
        probeTimeouts: 60,
        errorCounts: { probe: 60, file: 21 },
        issues: Array.from({ length: 40 }, () => ({
          path: "/home/safe-user/private-folder/safe-video.mp4",
          message:
            "filesystem error at /home/safe-user/private-folder/safe-video.mp4 token=private-token",
          stage: "file",
          extension: "mp4",
          sizeBytes: 1000,
          elapsedMs: 50,
        })),
      }),
    );
    expect(run.entries().filter((entry) => entry.event === "scan_issue")).toHaveLength(30);
    expect(
      run.entries().find((entry) => entry.event === "scan_issue_samples")?.context,
    ).toMatchObject({
      errors: 81,
      recorded: 30,
      omitted: 51,
      completeCounts: true,
    });
    expect(run.reports[0]!.before).toContain('"count":60');
    expect(run.reports[0]!.before).toContain('"count":21');
    const text = JSON.stringify(run.entries());
    expect(text).toContain("private-folder/safe-video.mp4");
    expect(text).toContain("filesystem error");
    for (const secret of ["private-token", "safe-user"]) expect(text).not.toContain(secret);
  });

  it("进度轮询不重复记录，同样错误的新任务仍各自留有报告", () => {
    const run = setup();
    for (let processed = 0; processed < 1000; processed++) run.publish(scan({ processed }));
    expect(run.entries()).toHaveLength(1);
    const partial = scan({ state: "partial", errors: 1, errorCounts: { probe: 1 } });
    run.publish(partial);
    const count = run.entries().length;
    for (let index = 0; index < 100; index++) run.publish({ ...partial });
    expect(run.entries()).toHaveLength(count);
    run.publish({ ...partial, id: "safe-next-scan" });
    expect(run.reports.map(({ input }) => input.taskId)).toEqual(["safe-scan", "safe-next-scan"]);
    run.stop();
    const stoppedCount = run.entries().length;
    run.publish(scan({ id: "safe-stopped" }));
    expect(run.entries()).toHaveLength(stoppedCount);
  });

  it("完成、取消不报失败，真正失败仍记录 error", () => {
    const run = setup();
    run.publish(scan({ id: "safe-complete", state: "completed", processed: 1, imported: 1 }));
    run.publish(
      scan({ id: "safe-cancelled", state: "cancelled", errors: 1, errorCounts: { file: 1 } }),
    );
    expect(run.reports).toHaveLength(0);
    run.publish(
      scan({ id: "safe-failed", state: "failed", errors: 1, errorCounts: { database: 1 } }),
    );
    expect(run.reports).toHaveLength(1);
    expect(terminal(run.entries())).toMatchObject({ event: "scan_failed", level: "error" });
  });

  it("旧原生扩展缺少诊断字段时不伪造耗时和超时总数", () => {
    const run = setup();
    const legacy = scan({
      state: "partial",
      errors: 40,
      issues: [{ path: "C:\\private\\safe.mp4", message: "媒体探测超时" }],
    });
    delete legacy.elapsedMs;
    delete legacy.probeTimeoutMs;
    delete legacy.probeTimeouts;
    delete legacy.errorCounts;
    delete legacy.storageKind;
    run.publish(legacy);
    const environment = run.entries().find((entry) => entry.event === "scan_diagnostics")!.context!;
    expect(environment).not.toHaveProperty("elapsedMs");
    expect(environment).not.toHaveProperty("probeTimeouts");
    expect(environment.storageKind).toBe("unknown");
    expect(
      run.entries().find((entry) => entry.event === "scan_error_count")?.context,
    ).toMatchObject({
      stage: "probe",
      count: 1,
      sampled: true,
    });
  });
});
