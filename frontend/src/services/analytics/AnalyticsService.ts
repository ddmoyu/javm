import { logEvent } from "../logging/events";
import { counters, emptyPayload, localStatDate, maxAnalyticsDays, readAnalytics } from "./contract";
import type {
  AnalyticsMetadata,
  AnalyticsPayload,
  AnalyticsPort,
  AnalyticsState,
  UsageCounter,
  UsageEvent,
} from "./contract";
import { ForegroundClock } from "./ForegroundClock";

export class AnalyticsUploadError extends Error {
  constructor(
    public readonly status: number,
    transportCode: number,
  ) {
    super(`使用统计上报失败（HTTP ${status}，传输代码 ${transportCode}），本地快照保留。`);
  }
}

/** 单实例服务：本地保存串行，网络独立且最多一个请求，均不阻塞业务入口。 */
export class AnalyticsService {
  private state?: AnalyticsState;
  private durable?: AnalyticsState;
  private revision = 0;
  private pending = new Map<string, Partial<Record<UsageCounter, number>>>();
  private acknowledgements = new Map<string, AnalyticsPayload>();
  private writePending?: AnalyticsState;
  private working?: Promise<void>;
  private uploading?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private started = false;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  private contextAt = -Infinity;
  private videoCount?: number;
  private clock: ForegroundClock;
  constructor(
    private port: AnalyticsPort,
    private metadata: AnalyticsMetadata,
    visible: () => boolean,
    private now: () => Date = () => new Date(),
    private monotonic: () => number = () => performance.now(),
  ) {
    this.clock = new ForegroundClock(now, monotonic, visible, (date, seconds) =>
      this.add("active_duration_seconds", seconds, date),
    );
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.clock.sample();
    this.add("app_launch_count", 1);
    this.timer = setInterval(() => {
      this.clock.sample();
      void this.flush();
    }, 15_000);
  }
  visibilityChanged = () => {
    if (!this.started || this.stopped) return;
    this.clock.sample();
    void this.flush();
  };
  record = (event: UsageEvent) => {
    if (!this.started || this.stopped) return;
    this.clock.sample();
    this.add(event, 1);
  };
  private add(counter: UsageCounter, value: number, date = localStatDate(this.now())) {
    if (this.stopped) return;
    if (!this.pending.has(date) && this.pending.size >= maxAnalyticsDays) {
      this.report(new Error("待保存统计已达上限。"));
      return;
    }
    const delta = this.pending.get(date) ?? {};
    delta[counter] = Math.min(Number.MAX_SAFE_INTEGER, (delta[counter] ?? 0) + value);
    this.pending.set(date, delta);
    this.schedule();
  }
  private schedule() {
    if (this.working || this.scheduled || this.stopped) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.flush();
    }, 0);
  }
  private report(error: unknown) {
    logEvent(
      "warn",
      "analytics",
      "operation_failed",
      error instanceof Error ? error.message : "使用统计暂不可用，稍后重试。",
    );
  }
  private async persist() {
    if (!this.writePending) return;
    await this.port.save(this.writePending, this.revision);
    this.revision++;
    this.durable = this.writePending;
    this.writePending = undefined;
  }
  private save() {
    this.writePending = structuredClone(this.state!);
    return this.persist();
  }
  private uploadNext() {
    if (
      this.stopped ||
      this.uploading ||
      this.writePending ||
      this.acknowledgements.size ||
      this.monotonic() < this.retryAt
    )
      return;
    const today = localStatDate(this.now());
    const day = this.durable?.days
      .filter((item) => item.pending && item.payload.stat_date < today)
      .sort((a, b) => a.payload.stat_date.localeCompare(b.payload.stat_date))[0];
    if (!day) return;
    const snapshot = { ...day.payload };
    const abort = new AbortController();
    this.abort = abort;
    const work = this.port
      .upload(snapshot, abort.signal)
      .then(() => {
        this.acknowledgements.set(snapshot.stat_date, snapshot);
        this.failures = 0;
        this.retryAt = 0;
      })
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.failures = Math.min(this.failures + 1, 7);
        const permanent =
          error instanceof AnalyticsUploadError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status);
        // 网络/限流 1、2、4…60 分钟退避；权限或结构错误 6 小时后再试。
        this.retryAt =
          this.monotonic() +
          (permanent ? 6 * 60 * 60_000 : Math.min(60, 2 ** (this.failures - 1)) * 60_000);
        this.report(error);
      });
    this.uploading = work.finally(() => {
      this.uploading = undefined;
      this.abort = undefined;
      // 确认记录与业务计数共用本地保存队列；网络从不占住该队列。
      if (this.acknowledgements.size && !this.stopped) void this.flush();
    });
  }
  private async drain() {
    if (!this.state) {
      const loaded = await this.port.load();
      this.state = readAnalytics(loaded);
      this.revision = loaded.revision;
      this.durable = loaded.state === null ? undefined : structuredClone(this.state);
      if (loaded.state === null) await this.save();
    }
    await this.persist();
    if (!this.pending.size && !this.acknowledgements.size) return;
    if (this.pending.size && this.monotonic() - this.contextAt >= 60_000) {
      this.contextAt = this.monotonic();
      try {
        const count = await this.port.videoCount();
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("影片总数无效。");
        this.videoCount = count;
      } catch (error) {
        this.report(error);
      }
    }
    const today = localStatDate(this.now());
    const buffered = [...this.pending];
    // 先合入新计数，再确认上传：迟到的计数不能被旧快照的成功回执抹掉。
    for (const [date, delta] of buffered) {
      let day = this.state.days.find((item) => item.payload.stat_date === date);
      if (!day) {
        this.state.days = this.state.days.filter(
          (item) =>
            item.pending ||
            item.payload.stat_date >= today ||
            this.pending.has(item.payload.stat_date),
        );
        if (this.state.days.length >= maxAnalyticsDays) break;
        day = { payload: emptyPayload(this.state.userId, date, this.metadata), pending: true };
        this.state.days.push(day);
      }
      for (const counter of counters)
        day.payload[counter] = Math.min(
          Number.MAX_SAFE_INTEGER,
          day.payload[counter] + (delta[counter] ?? 0),
        );
      Object.assign(day.payload, this.metadata);
      if (this.videoCount !== undefined) day.payload.video_total_count = this.videoCount;
      day.pending = true;
      this.pending.delete(date);
    }
    for (const [date, payload] of this.acknowledgements) {
      const day = this.state.days.find((item) => item.payload.stat_date === date);
      if (day && JSON.stringify(day.payload) === JSON.stringify(payload)) day.pending = false;
    }
    this.acknowledgements.clear();
    this.state.days = this.state.days.filter(
      (item) =>
        item.pending || item.payload.stat_date >= today || this.pending.has(item.payload.stat_date),
    );
    await this.save();
    if (this.pending.size && this.state.days.length >= maxAnalyticsDays)
      throw new Error("未同步统计已达 32 天上限，原记录保留。");
  }
  flush(): Promise<void> {
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    if (this.working) return this.working;
    let failed = false;
    this.working = this.drain()
      .catch((error: unknown) => {
        failed = true;
        this.report(error);
      })
      .finally(() => {
        this.working = undefined;
        if (!failed && (this.pending.size || this.acknowledgements.size)) this.schedule();
        // 即使积压满了，也可上传已落盘旧日以释放空间。
        this.uploadNext();
      });
    return this.working;
  }
  async syncNow() {
    // 手动重试也只发送已结束的日期，绝不提前发送当天数据。
    await this.flush();
    await this.uploading;
    await this.flush();
  }
  async shutdown() {
    if (!this.stopped) this.clock.sample();
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.scheduled);
    this.abort?.abort();
    await this.uploading;
    await this.working;
    // 退出仅落盘，包含可见性切换和最后不足一分钟的时间。
    await this.flush();
  }
}
