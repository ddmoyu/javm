import { playbackSourceKey } from "./source";
import type { PlaybackRequest } from "./source";

export interface PlaybackPosition {
  time: number;
  duration: number;
  ended?: boolean;
}
export interface PlaybackBookmark extends PlaybackPosition {
  key: string;
  updated: number;
}
export interface PlaybackHistoryStore {
  read(key: string): Promise<unknown>;
  write(bookmark: PlaybackBookmark): Promise<void>;
}
export interface PlaybackProgress {
  resumeAt: number;
  attach(read: () => PlaybackPosition | undefined): () => void;
  update(position: PlaybackPosition): void;
  flush(): Promise<void>;
}

export function resumePosition(time: number, duration: number) {
  return Number.isFinite(time) && Number.isFinite(duration) && time >= 5 && duration - time > 5
    ? time
    : 0;
}

export function readPlaybackBookmark(value: unknown): PlaybackBookmark | null {
  if (value === null) return null;
  const item = value as PlaybackBookmark;
  if (
    !item ||
    !/^[a-f0-9]{64}$/.test(item.key) ||
    !Number.isSafeInteger(item.updated) ||
    item.updated < 0 ||
    !Number.isFinite(item.time) ||
    item.time < 0 ||
    !Number.isFinite(item.duration) ||
    item.duration <= 0 ||
    item.time > item.duration
  )
    throw new Error("无效的播放进度记录");
  return { key: item.key, time: item.time, duration: item.duration, updated: item.updated };
}

export function readLegacyPlaybackHistory(value: unknown): PlaybackBookmark[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error("无效的旧版播放进度记录");
  return value.map((entry: unknown) => {
    const record = readPlaybackBookmark(entry);
    if (!record || !resumePosition(record.time, record.duration))
      throw new Error("无效的旧版播放进度记录");
    return record;
  });
}

/** 按视频读取一行；每个会话只保留一份待写位置，不加载或截断全部历史。 */
export class PlaybackHistory {
  constructor(private store: PlaybackHistoryStore) {}
  async session(request: PlaybackRequest): Promise<PlaybackProgress> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(playbackSourceKey(request)),
    );
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let saved: PlaybackBookmark | null;
    try {
      saved = readPlaybackBookmark(await this.store.read(key));
      if (saved && saved.key !== key) throw new Error("播放进度标识不匹配");
    } catch {
      throw new Error("无法读取播放进度，请检查数据库是否可用后重试。");
    }
    let read: (() => PlaybackPosition | undefined) | undefined;
    let pending: PlaybackBookmark | undefined;
    let flushing: Promise<void> | undefined;
    const update = (position: PlaybackPosition) => {
      if (
        !Number.isFinite(position.duration) ||
        position.duration <= 0 ||
        !Number.isFinite(position.time) ||
        position.time < 0
      )
        return;
      const time = position.ended ? 0 : resumePosition(position.time, position.duration);
      // 暂停时的周期采样不重复写库；零位置同样持久化，明确表示从头播放。
      const previous = pending ?? saved;
      if (previous?.time === time && previous.duration === position.duration) return;
      pending = { key, time, duration: position.duration, updated: Date.now() };
    };
    const capture = () => {
      const value = read?.();
      if (value) update(value);
    };
    return {
      resumeAt: saved?.time ?? 0,
      attach: (sample) => {
        read = sample;
        return () => {
          if (read === sample) {
            capture();
            read = undefined;
          }
        };
      },
      update,
      flush: () => {
        capture();
        if (flushing) return flushing;
        if (!pending) return Promise.resolve();
        flushing = (async () => {
          while (pending) {
            const record: PlaybackBookmark = pending;
            try {
              await this.store.write(record);
            } catch {
              throw new Error("播放进度未能保存，请检查数据目录是否可写后重试。");
            }
            saved = record;
            if (pending === record) pending = undefined;
          }
        })().finally(() => {
          flushing = undefined;
        });
        return flushing;
      },
    };
  }
}

/** 等待可定位区间后只恢复一次；暂停、结束和卸载时保留最后有效位置。 */
export function bindPlaybackProgress(
  video: HTMLVideoElement,
  progress: PlaybackProgress,
  report: (error: string) => void,
) {
  let restored = false;
  let lastSaved = Date.now();
  const sample = (): PlaybackPosition | undefined =>
    restored && video.readyState > 0
      ? { time: video.currentTime, duration: video.duration, ended: video.ended }
      : undefined;
  const detach = progress.attach(sample);
  const restore = () => {
    if (restored || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const time = resumePosition(progress.resumeAt, video.duration);
    if (
      time &&
      !Array.from({ length: video.seekable.length }, (_, i) => i).some(
        (i) => video.seekable.start(i) <= time && video.seekable.end(i) >= time,
      )
    )
      return;
    restored = true;
    if (time) video.currentTime = time;
  };
  const flush = () => {
    lastSaved = Date.now();
    void progress
      .flush()
      .then(() => report(""))
      .catch((error: unknown) =>
        report(error instanceof Error ? error.message : "播放进度未能保存。"),
      );
  };
  const update = () => {
    restore();
    const position = sample();
    if (position) progress.update(position);
    if (Date.now() - lastSaved >= 5000) flush();
  };
  const save = () => {
    update();
    flush();
  };
  for (const event of ["loadedmetadata", "durationchange", "canplay"])
    video.addEventListener(event, restore);
  video.addEventListener("timeupdate", update);
  video.addEventListener("pause", save);
  video.addEventListener("ended", save);
  restore();
  return () => {
    detach();
    for (const event of ["loadedmetadata", "durationchange", "canplay"])
      video.removeEventListener(event, restore);
    video.removeEventListener("timeupdate", update);
    video.removeEventListener("pause", save);
    video.removeEventListener("ended", save);
  };
}
