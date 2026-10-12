import {
  HlsPlanError,
  hlsFingerprint,
  planTrack,
  playlistDuration,
  playlistFiles,
  readPlaylist,
  selectTracks,
  spreadOrder,
} from "./hls";
import type { HlsResource } from "./hls";
import { configValue } from "./curlConfig";

export interface HlsTrackSource {
  prefix: "v" | "a";
  text: string;
  url: string;
}
export interface HlsPlannerTasks {
  parse: {
    input: { text: string; url: string };
    output: { kind: "media" } | { kind: "master"; candidates: ReturnType<typeof selectTracks> };
  };
  plan: {
    input: { tracks: HlsTrackSource[] };
    output: {
      playlists: { prefix: "v" | "a"; playlist: string; duration: number }[];
      encrypted: boolean;
      fingerprint: string;
      /** 只回传主线程需要的字段，地址留在规划器内。 */
      files: string[];
      durations: number[];
      inline: { file: string; bytes: Uint8Array }[];
    };
  };
  config: {
    input: { head: string[]; root: string; completed: string[] };
    output: { config: string; pending: number };
  };
  /** 本地播放列表引用的文件与总时长，供合并前核对与合并后校验。 */
  files: { input: { text: string }; output: { files: string[]; duration: number } };
}
type Operation = keyof HlsPlannerTasks;

/** 纯计算部分；在 Worker 里运行，测试环境可直接调用。 */
export function createPlannerCore() {
  let resources: HlsResource[] = [];
  const handle = <K extends Operation>(
    operation: K,
    input: HlsPlannerTasks[K]["input"],
  ): HlsPlannerTasks[K]["output"] => {
    if (operation === "parse") {
      const { text, url } = input as HlsPlannerTasks["parse"]["input"];
      const playlist = readPlaylist(text, url);
      return (
        playlist.kind === "master"
          ? { kind: "master", candidates: selectTracks(playlist) }
          : { kind: "media" }
      ) as HlsPlannerTasks[K]["output"];
    }
    if (operation === "plan") {
      const { tracks } = input as HlsPlannerTasks["plan"]["input"];
      const plans = tracks.map((track) => ({
        prefix: track.prefix,
        plan: planTrack(track.text, track.url, track.prefix),
      }));
      resources = plans.flatMap((item) => item.plan.resources);
      return {
        playlists: plans.map((item) => ({
          prefix: item.prefix,
          playlist: item.plan.playlist,
          duration: item.plan.duration,
        })),
        encrypted: plans.some((item) => item.plan.encrypted),
        fingerprint: hlsFingerprint(
          resources,
          tracks.map((track) => track.url),
        ),
        files: resources.map((item) => item.file),
        durations: resources.map((item) => item.duration),
        inline: resources
          .filter((item) => item.inline)
          .map((item) => ({ file: item.file, bytes: item.inline! })),
      } as HlsPlannerTasks[K]["output"];
    }
    if (operation === "config") {
      const { head, root, completed } = input as HlsPlannerTasks["config"]["input"];
      const done = new Set(completed);
      const lines = [...head];
      let pending = 0;
      for (const item of spreadOrder(resources)) {
        if (done.has(item.file) || item.inline) continue;
        pending++;
        lines.push(
          `url = ${configValue(item.url)}`,
          `output = ${configValue(`${root}/${item.file}`)}`,
        );
      }
      return { config: lines.join("\n"), pending } as HlsPlannerTasks[K]["output"];
    }
    const { text } = input as HlsPlannerTasks["files"]["input"];
    return {
      files: playlistFiles(text),
      duration: playlistDuration(text),
    } as HlsPlannerTasks[K]["output"];
  };
  return { handle };
}

export interface HlsPlanner {
  run<K extends Operation>(
    operation: K,
    input: HlsPlannerTasks[K]["input"],
    signal: AbortSignal,
  ): Promise<HlsPlannerTasks[K]["output"]>;
  close(): void;
}
export type HlsPlannerMessage =
  | { id: number; value: unknown }
  | { id: number; error: { message: string; plan: boolean } };

/**
 * 每个下载尝试一个规划器。给定 Worker 工厂时，大播放列表的解析与清单拼接都在
 * Worker 中进行；取消即终止 Worker。没有 Worker 的环境（单元测试）直接调用同一核心。
 */
export function createHlsPlanner(createWorker?: () => Worker): HlsPlanner {
  if (!createWorker) {
    const core = createPlannerCore();
    return {
      async run(operation, input, signal) {
        signal.throwIfAborted();
        await Promise.resolve();
        return core.handle(operation, input);
      },
      close() {},
    };
  }
  let worker: Worker | undefined;
  let sequence = 0;
  let broken: Error | undefined;
  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  const fail = (error: Error) => {
    broken = error;
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
    worker?.terminate();
    worker = undefined;
  };
  const start = () => {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = ({ data }: MessageEvent<HlsPlannerMessage>) => {
      const entry = waiting.get(data.id);
      if (!entry) return;
      waiting.delete(data.id);
      if ("error" in data)
        entry.reject(
          data.error.plan ? new HlsPlanError(data.error.message) : new Error(data.error.message),
        );
      else entry.resolve(data.value);
    };
    worker.onerror = worker.onmessageerror = () =>
      fail(new Error("HLS 播放列表解析进程异常退出，请重试。"));
    return worker;
  };
  return {
    run(operation, input, signal) {
      if (broken) return Promise.reject(broken);
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const abort = () => {
          // 正在计算的 Worker 无法中途停下，直接终止；后续调用会新建 Worker。
          waiting.delete(id);
          reject(signal.reason);
          worker?.terminate();
          worker = undefined;
          for (const entry of waiting.values()) entry.reject(signal.reason);
          waiting.clear();
        };
        signal.addEventListener("abort", abort, { once: true });
        waiting.set(id, {
          resolve: (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value as HlsPlannerTasks[typeof operation]["output"]);
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
        try {
          start().postMessage({ id, operation, input });
        } catch (error) {
          waiting.delete(id);
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      });
    },
    close() {
      fail(new Error("HLS 规划器已关闭。"));
    },
  };
}
