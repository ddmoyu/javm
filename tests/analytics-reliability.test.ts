import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AnalyticsService,
  AnalyticsUploadError,
} from "../frontend/src/services/analytics/AnalyticsService";
import { ForegroundClock } from "../frontend/src/services/analytics/ForegroundClock";
import { emptyPayload } from "../frontend/src/services/analytics/contract";
import type { AnalyticsPayload, AnalyticsState } from "../frontend/src/services/analytics/contract";

const metadata = {
  os: "windows",
  cpu_arch: "x86_64",
  system_language: "zh-CN",
  app_version: "1.0.7",
};
const userId = "00000000-0000-4000-8000-000000000001";
const services: AnalyticsService[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 12));
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});
async function settle(service: AnalyticsService) {
  for (let i = 0; i < 6; i++) {
    await service.flush();
    await Promise.resolve();
  }
}
function fixture(old = true) {
  let saved: AnalyticsState = {
    version: 1,
    userId,
    days: old ? [{ payload: emptyPayload(userId, "2026-10-14", metadata), pending: true }] : [],
  };
  let revision = 1;
  const port = {
    load: vi.fn(async () => ({
      state: structuredClone(saved),
      revision,
      legacyMeta: [],
      legacyDays: [],
    })),
    save: vi.fn(async (state: AnalyticsState, expected: number) => {
      if (revision === expected + 1 && JSON.stringify(saved) === JSON.stringify(state)) return;
      if (revision !== expected) throw new Error("stale snapshot");
      saved = structuredClone(state);
      revision++;
    }),
    videoCount: vi.fn(async () => 8),
    upload: vi.fn(async (_payload: AnalyticsPayload, _signal: AbortSignal) => {}),
  };
  const service = new AnalyticsService(
    port,
    metadata,
    () => true,
    () => new Date(),
    () => Date.now(),
  );
  services.push(service);
  return { service, port, saved: () => saved };
}
function deferUpload(f: ReturnType<typeof fixture>) {
  let complete!: () => void;
  f.port.upload.mockImplementationOnce(
    (_payload, signal) =>
      new Promise<void>((resolve, reject) => {
        complete = resolve;
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  return () => complete();
}
describe("统计可靠性优化（安全 mock，无生产上报）", () => {
  it("网络挂起不阻塞当前计数落盘，启动计数先保存后上传", async () => {
    const f = fixture();
    deferUpload(f);
    f.service.start();
    await f.service.flush();
    expect(f.port.save.mock.invocationCallOrder[0]!).toBeLessThan(
      f.port.upload.mock.invocationCallOrder[0]!,
    );
    f.service.record("download_video_failed_count");
    await f.service.flush();
    expect(f.saved().days.at(-1)!.payload.download_video_failed_count).toBe(1);
    expect(f.port.upload).toHaveBeenCalledTimes(1);
    await f.service.shutdown();
    expect(f.saved().days[0]!.pending).toBe(true);
  });
  it("同日启动、手动重试和退出均不上传当天，次日才上传", async () => {
    const f = fixture(false);
    f.service.start();
    await settle(f.service);
    f.service.record("play_video_count");
    await f.service.syncNow();
    expect(f.port.upload).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 9, 16, 0));
    await settle(f.service);
    expect(f.port.upload).toHaveBeenCalledTimes(1);
    expect(f.port.upload.mock.calls[0]![0]).toMatchObject({
      stat_date: "2026-10-15",
      play_video_count: 1,
      app_launch_count: 1,
    });
    await f.service.shutdown();
    expect(f.port.upload).toHaveBeenCalledTimes(1);
  });
  it("旧回执不能清除上传期间新增的同日计数", async () => {
    const f = fixture();
    const complete = deferUpload(f);
    f.service.start();
    await f.service.flush();
    vi.setSystemTime(new Date(2026, 9, 14, 23, 59));
    f.service.record("play_video_count");
    await f.service.flush();
    vi.setSystemTime(new Date(2026, 9, 15, 0));
    complete();
    await settle(f.service);
    expect(f.port.upload.mock.calls.map((call) => call[0].play_video_count)).toEqual([0, 1]);
    expect(f.saved().days.every((day) => day.payload.stat_date === "2026-10-15")).toBe(true);
  });
  it("离线指数退避期间新业务仍保存，不靠新事件绕过退避", async () => {
    const f = fixture();
    f.port.upload.mockRejectedValue(new Error("offline"));
    f.service.start();
    await settle(f.service);
    const start = Date.now();
    for (const elapsed of [15_000, 59_000]) {
      vi.setSystemTime(start + elapsed);
      f.service.record("play_video_count");
      await settle(f.service);
    }
    expect(f.port.upload).toHaveBeenCalledTimes(1);
    expect(f.saved().days.at(-1)!.payload.play_video_count).toBe(2);
    vi.setSystemTime(start + 60_000);
    await settle(f.service);
    expect(f.port.upload).toHaveBeenCalledTimes(2);
    vi.setSystemTime(start + 179_000);
    await settle(f.service);
    expect(f.port.upload).toHaveBeenCalledTimes(2);
    vi.setSystemTime(start + 180_000);
    await settle(f.service);
    expect(f.port.upload).toHaveBeenCalledTimes(3);
  });
  it("权限错误退避六小时且保留快照", async () => {
    const f = fixture();
    f.port.upload.mockRejectedValue(new AnalyticsUploadError(403, 0));
    f.service.start();
    await settle(f.service);
    const start = Date.now();
    vi.setSystemTime(start + 5 * 60 * 60_000);
    await f.service.syncNow();
    expect(f.port.upload).toHaveBeenCalledTimes(1);
    expect(f.saved().days[0]!.pending).toBe(true);
    vi.setSystemTime(start + 6 * 60 * 60_000);
    await settle(f.service);
    expect(f.port.upload).toHaveBeenCalledTimes(2);
  });
  it("写入响应丢失重放同一快照，视频总数读取失败不丢计数", async () => {
    const f = fixture(false);
    const save = f.port.save.getMockImplementation()!;
    f.port.save.mockImplementationOnce(async (state, revision) => {
      await save(state, revision);
      throw new Error("lost reply");
    });
    f.port.videoCount.mockRejectedValue(new Error("library restoring"));
    f.service.start();
    await f.service.flush();
    f.service.record("download_video_failed_count");
    await settle(f.service);
    expect(f.saved().days[0]!.payload).toMatchObject({
      app_launch_count: 1,
      download_video_failed_count: 1,
    });
    expect(f.port.upload).not.toHaveBeenCalled();
  });
});
describe("主窗口可见时长", () => {
  function clockFixture(start = new Date(2026, 9, 15, 12).getTime()) {
    let wall = start,
      monotonic = 0,
      visible = true;
    const totals = new Map<string, number>();
    const clock = new ForegroundClock(
      () => new Date(wall),
      () => monotonic,
      () => visible,
      (date, seconds) => totals.set(date, (totals.get(date) ?? 0) + seconds),
    );
    clock.sample();
    return {
      clock,
      totals,
      move(ms: number, show = visible, wallMs = ms) {
        wall += wallMs;
        monotonic += ms;
        visible = show;
        clock.sample();
      },
    };
  }
  it("隐藏与退出结算尾段，不按整分钟多算或漏算", () => {
    const f = clockFixture();
    f.move(15_000);
    f.move(5_250, false);
    f.move(15_000);
    f.move(10_000, true);
    f.move(4_750);
    expect([...f.totals.values()]).toEqual([25]);
  });
  it("跨午夜按当地日期拆分可见时间", () => {
    const f = clockFixture(new Date(2026, 9, 15, 23, 59, 50).getTime());
    f.move(20_000);
    expect(Object.fromEntries(f.totals)).toEqual({ "2026-10-15": 10, "2026-10-16": 10 });
  });
  it("休眠和系统调钟不产生虚假活跃时长", () => {
    const f = clockFixture();
    f.move(3_600_000);
    f.move(1000, true, -3_600_000);
    f.move(1000, true, 3_600_000);
    f.move(10_000);
    expect([...f.totals.values()]).toEqual([10]);
  });
});
