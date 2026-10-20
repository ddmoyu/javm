import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AnalyticsService } from "../frontend/src/services/analytics/AnalyticsService";
import { emptyPayload, localStatDate } from "../frontend/src/services/analytics/contract";
import type {
  AnalyticsLoad,
  AnalyticsPayload,
  AnalyticsState,
} from "../frontend/src/services/analytics/contract";
import { analyticsRequest } from "../frontend/src/services/analytics/supabase";
import { recordUsage, setUsageRecorder } from "../frontend/src/services/analytics/events";

const userId = "00000000-0000-4000-8000-000000000001";
const metadata = {
  os: "windows",
  cpu_arch: "x86_64",
  system_language: "zh-CN",
  app_version: "1.0.7",
};
const services: AnalyticsService[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 12));
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  setUsageRecorder();
  vi.useRealTimers();
});
function setup(initial?: AnalyticsState, legacy?: Partial<AnalyticsLoad>) {
  let state = initial ? structuredClone(initial) : null;
  let revision = initial ? 1 : 0;
  let visible = true;
  const uploads: AnalyticsPayload[] = [];
  const port = {
    load: vi.fn(async () => ({
      revision,
      state: structuredClone(state),
      legacyMeta: [],
      legacyDays: [],
      ...legacy,
    })),
    save: vi.fn(async (value: AnalyticsState, expected: number) => {
      if (revision === expected + 1 && JSON.stringify(state) === JSON.stringify(value)) return;
      if (revision !== expected) throw new Error("revision conflict");
      state = structuredClone(value);
      revision++;
    }),
    videoCount: vi.fn(async () => 7),
    upload: vi.fn(async (payload: AnalyticsPayload, _signal: AbortSignal) => {
      uploads.push(structuredClone(payload));
    }),
  };
  const service = new AnalyticsService(
    port,
    metadata,
    () => visible,
    () => new Date(),
    () => Date.now(),
  );
  services.push(service);
  return {
    service,
    port,
    uploads,
    saved: () => state!,
    visible: (value: boolean) => {
      visible = value;
      service.visibilityChanged();
    },
  };
}
function oldState(date = "2026-10-14"): AnalyticsState {
  return {
    version: 1,
    userId,
    days: [
      { payload: { ...emptyPayload(userId, date, metadata), play_video_count: 3 }, pending: true },
    ],
  };
}
async function settle(service: AnalyticsService) {
  // flush 只等待本地保存；允许独立网络回执进入下一次保存。
  for (let i = 0; i < 6; i++) {
    await service.flush();
    await Promise.resolve();
  }
}
describe("旧版 Supabase 使用统计迁移（隔离模拟网络）", () => {
  it("保留请求契约，使用当地日期，只发送旧版 14 个字段", () => {
    const payload = emptyPayload(userId, localStatDate(new Date(2026, 0, 2, 1)), metadata);
    const request = analyticsRequest(payload, "http://127.0.0.1:1234");
    expect(request.url).toMatch(/\/rest\/v1\/app_daily_stats\?on_conflict=user_id$/);
    expect(request.headers?.Prefer).toBe("resolution=merge-duplicates,return=minimal");
    expect(request.headers?.apikey).toMatch(/^sb_publishable_/);
    expect(request.headers).not.toHaveProperty("Authorization");
    expect(request.timeoutMs).toBe(12_000);
    expect(request.maxRedirects).toBe(0);
    expect(Object.keys(JSON.parse(request.body!)[0])).toHaveLength(14);
    expect(payload.stat_date).toBe("2026-01-02");
    expect(payload.download_video_failed_count).toBe(0);
  });
  it("幂等启动，60 秒可见计时，隐藏暂停，当前日只保存不上报", async () => {
    const f = setup();
    f.service.start();
    f.service.start();
    await f.service.flush();
    await vi.advanceTimersByTimeAsync(60_001);
    f.visible(false);
    await vi.advanceTimersByTimeAsync(120_000);
    const payload = f.saved().days[0]!.payload;
    expect(payload.app_launch_count).toBe(1);
    expect(payload.active_duration_seconds).toBe(60);
    expect(payload.video_total_count).toBe(7);
    expect(f.uploads).toEqual([]);
    await f.service.shutdown();
    f.visible(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.saved().days[0]!.payload.active_duration_seconds).toBe(60);
  });
  it("恢复原匿名身份和旧快照，先落盘再上报前一天，开始当天计数", async () => {
    const old = { ...oldState().days[0]!.payload, current_video_total_count: 4, needs_sync: 1 };
    const f = setup(undefined, {
      legacyMeta: [{ key: "analytics_user_id", value: userId }],
      legacyDays: [old],
    });
    f.service.start();
    await settle(f.service);
    expect(f.saved().userId).toBe(userId);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]).toMatchObject({
      stat_date: "2026-10-14",
      play_video_count: 3,
      video_total_count: 4,
    });
    expect(f.port.save.mock.invocationCallOrder[0]!).toBeLessThan(
      f.port.upload.mock.invocationCallOrder[0]!,
    );
    expect(f.saved().days).toHaveLength(1);
    expect(f.saved().days[0]!.payload).toMatchObject({
      stat_date: "2026-10-15",
      app_launch_count: 1,
      play_video_count: 0,
    });
  });
  it("失败保留旧日，上报期间的新操作合并保存，下一分钟按日期重试", async () => {
    const f = setup(oldState());
    f.port.upload.mockImplementationOnce(async () => {
      f.service.record("play_video_count");
      f.service.record("download_video_count");
      throw new Error("模拟离线");
    });
    f.service.start();
    await settle(f.service);
    expect(f.saved().days).toHaveLength(2);
    expect(f.saved().days[1]!.payload).toMatchObject({
      play_video_count: 1,
      download_video_count: 1,
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]!.stat_date).toBe("2026-10-14");
    expect(f.saved().days).toHaveLength(1);
  });
  it("午夜后上传昨天，当前日计数归零，手动重试也不提前上传当天", async () => {
    const f = setup();
    f.service.start();
    await f.service.flush();
    f.service.record("search_designation_count");
    await f.service.flush();
    vi.setSystemTime(new Date(2026, 9, 16, 0));
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.uploads[0]).toMatchObject({ stat_date: "2026-10-15", search_designation_count: 1 });
    expect(f.saved().days[0]!.payload).toMatchObject({
      stat_date: "2026-10-16",
      search_designation_count: 0,
      active_duration_seconds: 45,
      app_launch_count: 0,
    });
    await f.service.syncNow();
    expect(f.uploads.at(-1)!.stat_date).toBe("2026-10-15");
  });
  it("写入失败不清空数据、不忙重试，后续事件先重试快照再累计", async () => {
    const f = setup(oldState("2026-10-15"));
    f.port.save.mockRejectedValueOnce(new Error("模拟写盘失败"));
    f.service.start();
    await f.service.flush();
    expect(f.port.save).toHaveBeenCalledTimes(1);
    expect(f.saved().days[0]!.payload.app_launch_count).toBe(0);
    f.service.record("search_resource_link_count");
    await f.service.flush();
    expect(f.saved().days[0]!.payload).toMatchObject({
      app_launch_count: 1,
      search_resource_link_count: 1,
      play_video_count: 3,
    });
  });
  it("损坏的旧状态不生成新身份、不覆盖原记录，也不发送请求", async () => {
    const f = setup({ ...oldState(), userId: "damaged" });
    f.service.start();
    await f.service.flush();
    expect(f.port.save).not.toHaveBeenCalled();
    expect(f.port.upload).not.toHaveBeenCalled();
  });
  it("写入已提交但响应丢失时重放同一快照，不重复累计启动或播放", async () => {
    const f = setup(oldState("2026-10-15"));
    const save = f.port.save.getMockImplementation()!;
    f.port.save.mockImplementationOnce(async (state, revision) => {
      await save(state, revision);
      throw new Error("模拟提交后响应丢失");
    });
    f.service.start();
    await f.service.flush();
    f.service.record("play_video_count");
    await f.service.flush();
    expect(f.saved().days[0]!.payload).toMatchObject({ app_launch_count: 1, play_video_count: 4 });
  });
  it("跨日上报期间的迟到事件保留当天原计数，不只留下增量", async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 23, 59));
    const f = setup(oldState());
    f.service.start();
    // 初始化的日期已固定，但加载完成时本地时钟进入次日。
    vi.setSystemTime(new Date(2026, 9, 15, 0));
    await settle(f.service);
    expect(f.uploads[0]).toMatchObject({
      stat_date: "2026-10-14",
      app_launch_count: 1,
      play_video_count: 3,
    });
    await f.service.syncNow();
    expect(f.uploads.at(-1)).toMatchObject({ app_launch_count: 1, play_video_count: 3 });
  });
  it("退出取消正在上报的请求，保存已接收事件且不额外上报当天", async () => {
    const f = setup(oldState());
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    f.port.upload.mockImplementationOnce(async (_payload, signal) => {
      begin();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    });
    f.service.start();
    const work = f.service.flush();
    await begun;
    f.service.record("play_video_count");
    await f.service.shutdown();
    await work;
    expect(f.saved().days[0]!.pending).toBe(true);
    expect(f.saved().days[1]!.payload.play_video_count).toBe(1);
    expect(f.port.upload).toHaveBeenCalledTimes(1);
  });
  it("未启用时业务事件为空操作，接入后一次记录一个计数", async () => {
    recordUsage("play_video_count");
    const f = setup();
    f.service.start();
    setUsageRecorder(f.service.record);
    recordUsage("play_video_count");
    recordUsage("search_resource_link_count");
    await f.service.flush();
    expect(f.saved().days[0]!.payload).toMatchObject({
      play_video_count: 1,
      search_resource_link_count: 1,
    });
  });
});
