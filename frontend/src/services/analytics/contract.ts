export const counters = [
  "play_video_count",
  "download_video_count",
  "download_video_failed_count",
  "app_launch_count",
  "active_duration_seconds",
  "search_designation_count",
  "search_resource_link_count",
] as const;
export type UsageCounter = (typeof counters)[number];
export type UsageEvent = Exclude<UsageCounter, "app_launch_count" | "active_duration_seconds">;
export type AnalyticsMetadata = {
  os: string;
  cpu_arch: string;
  system_language: string;
  app_version: string;
};
export type AnalyticsPayload = AnalyticsMetadata &
  Record<UsageCounter, number> & {
    user_id: string;
    stat_date: string;
    video_total_count: number;
  };
export interface AnalyticsDay {
  payload: AnalyticsPayload;
  pending: boolean;
}
export interface AnalyticsState {
  version: 1;
  userId: string;
  days: AnalyticsDay[];
}
export interface AnalyticsLoad {
  revision: number;
  state: unknown;
  legacyMeta: { key: string; value: string }[];
  legacyDays: Record<string, unknown>[];
}
export interface AnalyticsPort {
  load(): Promise<AnalyticsLoad>;
  save(state: AnalyticsState, expectedRevision: number): Promise<void>;
  videoCount(): Promise<number>;
  upload(payload: AnalyticsPayload, signal: AbortSignal): Promise<void>;
}
export const maxAnalyticsDays = 32;
export function localStatDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function emptyPayload(
  userId: string,
  date: string,
  metadata: AnalyticsMetadata,
): AnalyticsPayload {
  return {
    user_id: userId,
    stat_date: date,
    ...metadata,
    play_video_count: 0,
    download_video_count: 0,
    app_launch_count: 0,
    active_duration_seconds: 0,
    search_designation_count: 0,
    search_resource_link_count: 0,
    download_video_failed_count: 0,
    video_total_count: 0,
  };
}
function count(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("使用统计计数无效，原记录保留。");
  return value;
}
function validUserId(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}
function readPayload(raw: Record<string, unknown>, legacy = false): AnalyticsPayload {
  if (
    !validUserId(raw.user_id) ||
    typeof raw.stat_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.stat_date)
  )
    throw new Error("使用统计身份或日期无效，原记录保留。");
  const metadata = {} as AnalyticsMetadata;
  for (const key of ["os", "cpu_arch", "system_language", "app_version"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || value.length > 128) throw new Error("使用统计环境字段无效。");
    metadata[key] = value;
  }
  const result = emptyPayload(raw.user_id, raw.stat_date, metadata);
  for (const key of counters)
    result[key] = count(legacy && key === "download_video_failed_count" ? 0 : raw[key]);
  result.video_total_count = count(raw[legacy ? "current_video_total_count" : "video_total_count"]);
  return result;
}
export function readAnalytics(load: AnalyticsLoad): AnalyticsState {
  if (!Number.isSafeInteger(load.revision) || load.revision < 0)
    throw new Error("使用统计版本无效。");
  if (load.state !== null) {
    const state = load.state as AnalyticsState;
    if (
      !state ||
      state.version !== 1 ||
      !validUserId(state.userId) ||
      !Array.isArray(state.days) ||
      state.days.length > maxAnalyticsDays
    )
      throw new Error("使用统计记录无效，原记录保留。");
    const dates = new Set<string>();
    return {
      version: 1,
      userId: state.userId,
      days: state.days.map((day) => {
        const payload = readPayload(day.payload);
        if (
          payload.user_id !== state.userId ||
          typeof day.pending !== "boolean" ||
          dates.has(payload.stat_date)
        )
          throw new Error("使用统计记录冲突，原记录保留。");
        dates.add(payload.stat_date);
        return { payload, pending: day.pending };
      }),
    };
  }
  const oldId = load.legacyMeta.find((row) => row.key === "analytics_user_id")?.value;
  const userId = oldId || load.legacyDays[0]?.user_id || crypto.randomUUID();
  if (!validUserId(userId)) throw new Error("旧使用统计标识无效，原记录保留。");
  const days: AnalyticsDay[] = [];
  for (const row of load.legacyDays) {
    if (row.user_id !== userId) continue;
    const payload = readPayload(row, true);
    const existing = days.find((day) => day.payload.stat_date === payload.stat_date);
    if (existing) {
      for (const key of counters)
        existing.payload[key] = count(existing.payload[key] + payload[key]);
      existing.pending ||= row.needs_sync !== 0;
    } else days.push({ payload, pending: row.needs_sync !== 0 });
  }
  if (days.length > maxAnalyticsDays) throw new Error("旧使用统计超过迁移上限。");
  return { version: 1, userId, days };
}
