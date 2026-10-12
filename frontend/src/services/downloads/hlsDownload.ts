import type { DownloadTask } from "../../contracts/downloads";
import type { ProcessResult, ProcessRunner } from "../../platform/neutralino/process";
import type { DownloadProgress } from "./ports";
import type { DownloadFiles } from "./ToolDownloadEngine";
import { joinPath } from "./input";
import { OutputLines } from "./progress";
import { curlExitHint } from "./network";
import { configValue, curlContext, curlSafety } from "./curlConfig";
import {
  HlsPlanError,
  HlsSizeEstimate,
  hlsLimits,
  parseTransfer,
  transferAccepted,
  transferFormat,
} from "./hls";
import type { HlsPlanner } from "./hlsPlanner";

/** 单任务内的分片并发；任务之间的并发由下载服务的队列控制。 */
const segmentParallel = 8;
/** 核对本地文件大小时同时进行的文件属性请求数。 */
const statParallel = 16;
/** 主线程上逐项处理时，每批的条目数；批次之间让出事件循环。 */
const yieldBatch = 4096;
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface HlsState {
  fingerprint: string;
  completed: Record<string, number>;
}
export interface HlsDownloadContext {
  task: DownloadTask;
  curl: string;
  proxy: string;
  files: DownloadFiles;
  run: ProcessRunner;
  signal: AbortSignal;
  progress: (update: DownloadProgress) => void;
  /** 加密播放列表需要 FFmpeg 的 crypto 协议。 */
  supportsDecryption: () => Promise<boolean>;
  /** 播放列表解析、规划与清单拼接都交给规划器，避免在 UI 主线程整批计算。 */
  planner: HlsPlanner;
}
export interface HlsDownloadResult {
  result: ProcessResult;
  inputs: string[];
}

/** 临时文件清理失败不应掩盖下载本身的结果。 */
const quietly = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    () => undefined,
  );

/**
 * 找出不能视为完整的本地文件：没有完成记录、缺失、为空，或者大小与下载完成时
 * 记录的字节数不同。没有记录的文件可能是被强制结束时写了一半的分片，一律重新下载。
 * 文件属性按有限并发异步读取，每次等待都会让出事件循环。
 */
export async function mismatchedFiles(
  files: DownloadFiles,
  root: string,
  names: string[],
  recorded: Record<string, number>,
  signal: AbortSignal,
) {
  const mismatched: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      signal.throwIfAborted();
      const name = names[next++]!;
      const expected = recorded[name];
      if (expected === undefined) {
        mismatched.push(name);
        continue;
      }
      const stat = await files.stat(joinPath(root, name));
      if (!stat?.isFile || stat.size !== expected) mismatched.push(name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(statParallel, names.length) }, worker));
  return mismatched;
}

/** 读取进度记录；格式不对或损坏时视为没有记录。 */
export async function readHlsState(files: DownloadFiles, root: string) {
  const path = joinPath(root, "state.json");
  if (!(await files.stat(path))) return undefined;
  try {
    const saved = JSON.parse(await files.read(path)) as Partial<HlsState>;
    if (typeof saved.fingerprint !== "string" || !saved.completed) return undefined;
    if (typeof saved.completed !== "object" || Array.isArray(saved.completed)) return undefined;
    const completed: Record<string, number> = {};
    for (const [file, bytes] of Object.entries(saved.completed))
      if (typeof bytes === "number" && bytes > 0) completed[file] = bytes;
    return { fingerprint: saved.fingerprint, completed };
  } catch {
    return undefined;
  }
}

export async function downloadHls(context: HlsDownloadContext): Promise<HlsDownloadResult> {
  const { task, files, signal, progress, planner } = context;
  const root = joinPath(task.workDirectory, "hls");
  await files.mkdir(root);
  const failed = (result: ProcessResult): HlsDownloadResult => ({ result, inputs: [] });

  const fetchPlaylist = async (url: string) => {
    const output = joinPath(root, "fetch.m3u8");
    const config = joinPath(root, "fetch.curl");
    await quietly(files.remove(output));
    await files.write(
      config,
      [
        ...curlContext(task, context.proxy),
        `url = ${configValue(url)}`,
        `output = ${configValue(output)}`,
      ].join("\n"),
    );
    let result: ProcessResult;
    try {
      result = await context.run(
        context.curl,
        [
          "--disable",
          "--config",
          config,
          ...curlSafety,
          "--max-filesize",
          String(hlsLimits.playlistBytes),
          "--retry",
          "2",
          "--silent",
          "--show-error",
          "--write-out",
          "%{url_effective}",
        ],
        signal,
        undefined,
        true,
      );
    } finally {
      await quietly(files.remove(config));
    }
    signal.throwIfAborted();
    if (result.exitCode !== 0) return { result };
    // 200 但没有正文时 curl 不创建输出文件。
    const stat = await files.stat(output);
    if (!stat?.isFile || stat.size <= 0) throw new HlsPlanError("服务器返回了空的 HLS 播放列表。");
    const text = await files.read(output);
    await quietly(files.remove(output));
    return { result, text, url: result.stdOut.trim() || url };
  };

  progress({ line: "正在读取 HLS 播放列表。", progress: null, speed: 0 });
  const master = await fetchPlaylist(task.url);
  if (master.text === undefined) return failed(master.result);
  const parsed = await planner.run("parse", { text: master.text, url: master.url! }, signal);
  let tracks: { prefix: "v" | "a"; text: string; url: string }[] = [];
  // 主播放列表声明的码率（bit/s），用于下载初期的大小估算。
  let bandwidth = 0;
  if (parsed.kind === "master") {
    // 最佳清晰度的子列表不可用（HTTP 4xx/5xx）时退到下一档；网络错误交给代理重试。
    let lastHttpFailure: ProcessResult | undefined;
    for (const candidate of parsed.candidates) {
      const picked: typeof tracks = [];
      let httpFailure: ProcessResult | undefined;
      for (const [prefix, url] of [
        ["v", candidate.video],
        ["a", candidate.audio],
      ] as const) {
        if (!url) continue;
        const media = await fetchPlaylist(url);
        if (media.text === undefined) {
          if (media.result.exitCode !== 22) return failed(media.result);
          httpFailure = media.result;
          break;
        }
        picked.push({ prefix, text: media.text, url: media.url! });
      }
      if (!httpFailure) {
        tracks = picked;
        bandwidth = candidate.bandwidth;
        break;
      }
      lastHttpFailure = httpFailure;
      progress({ line: "当前清晰度不可用，正在尝试下一个清晰度。" });
    }
    if (!tracks.length) return failed(lastHttpFailure!);
  } else tracks.push({ prefix: "v", text: master.text, url: master.url! });

  const plan = await planner.run("plan", { tracks }, signal);
  if (plan.encrypted && !(await context.supportsDecryption()))
    throw new HlsPlanError("该视频使用 AES-128 加密，当前 FFmpeg 组件不支持解密，请更新软件包。");
  const inputs: string[] = [];
  for (const item of plan.playlists) {
    const path = joinPath(root, item.prefix === "v" ? "video.m3u8" : "audio.m3u8");
    await files.write(path, item.playlist);
    inputs.push(path);
  }

  const statePath = joinPath(root, "state.json");
  const saved = await readHlsState(files, root);
  // 指纹不同说明资源已经变化（换了清晰度、域名或参数），旧分片一律不复用。
  const state: HlsState = {
    fingerprint: plan.fingerprint,
    completed: saved?.fingerprint === plan.fingerprint ? saved.completed : {},
  };
  const known = new Set(plan.files);
  for (const file of Object.keys(state.completed))
    if (!known.has(file)) delete state.completed[file];
  const recorded = Object.keys(state.completed);
  if (recorded.length) {
    // 只信任大小与记录一致的文件；截断或被替换的分片重新下载。
    progress({ line: `正在核对已下载的 ${recorded.length} 个分片。` });
    for (const file of await mismatchedFiles(files, root, recorded, state.completed, signal))
      delete state.completed[file];
  }
  // 内嵌密钥不经网络，直接写入本地文件。
  for (const item of plan.inline) {
    if (item.file in state.completed) continue;
    if (!files.writeBinary) throw new HlsPlanError("当前环境无法写入 HLS 内嵌密钥。");
    await files.writeBinary(joinPath(root, item.file), item.bytes);
    state.completed[item.file] = item.bytes.length;
  }

  const total = plan.files.length;
  // BANDWIDTH 覆盖该清晰度的全部轨道，乘以视频时长即为整部影片的初始估算。
  const estimate = new HlsSizeEstimate([], (bandwidth / 8) * plan.playlists[0]!.duration);
  // 5 万个分片一次建立约需 50 ms；分批进行，批次之间让出事件循环。
  for (let start = 0; start < total; start += yieldBatch) {
    signal.throwIfAborted();
    const end = Math.min(total, start + yieldBatch);
    const batch: { url: string; file: string; duration: number }[] = [];
    for (let index = start; index < end; index++)
      batch.push({ url: "", file: plan.files[index]!, duration: plan.durations[index]! });
    estimate.addResources(batch);
    await yieldToEventLoop();
  }
  const recordedEntries = Object.entries(state.completed);
  for (let start = 0; start < recordedEntries.length; start += yieldBatch) {
    signal.throwIfAborted();
    for (const [file, bytes] of recordedEntries.slice(start, start + yieldBatch))
      estimate.record(file, bytes);
    await yieldToEventLoop();
  }
  const samples: { time: number; bytes: number }[] = [
    { time: performance.now(), bytes: estimate.snapshot().downloaded },
  ];
  const report = () => {
    const size = estimate.snapshot();
    const now = performance.now();
    samples.push({ time: now, bytes: size.downloaded });
    while (samples.length > 2 && now - samples[0]!.time > 5000) samples.shift();
    const first = samples[0]!;
    const seconds = (now - first.time) / 1000;
    progress({
      progress: size.progress,
      downloaded: size.downloaded,
      total: size.total,
      totalIsEstimate: size.estimated,
      speed: seconds > 0 ? Math.max(0, (size.downloaded - first.bytes) / seconds) : 0,
    });
  };
  // 进度记录单线写入：同一时间只有一次写盘，期间的新快照只保留最新一份，慢盘不会积压。
  // 先写临时文件再改名替换，被中断时最多丢失最后一次更新，不会留下半截的 state.json。
  let writing: Promise<void> | undefined;
  let queued = false;
  let lastSaved = 0;
  const flush = async () => {
    while (queued) {
      queued = false;
      const snapshot = JSON.stringify(state);
      const temporary = `${statePath}.tmp`;
      await quietly(files.write(temporary, snapshot).then(() => files.move(temporary, statePath)));
    }
  };
  const save = (force = false) => {
    if (!force && performance.now() - lastSaved < 2000) return writing ?? Promise.resolve();
    lastSaved = performance.now();
    queued = true;
    writing ??= flush().finally(() => {
      writing = undefined;
    });
    return writing;
  };

  // 均匀取样的顺序与 curl 清单都在规划器里生成，让早期估算覆盖整部影片。
  const segments = await planner.run(
    "config",
    { head: curlContext(task, context.proxy), root, completed: Object.keys(state.completed) },
    signal,
  );
  report();
  if (!segments.pending) {
    await save(true);
    return { result: { exitCode: 0, stdOut: "", stdErr: "" }, inputs };
  }

  progress({ line: `正在下载 ${segments.pending} / ${total} 个 HLS 分片。` });
  const config = joinPath(root, "segments.curl");
  await files.write(config, segments.config);
  const failures: NonNullable<ReturnType<typeof parseTransfer>>[] = [];
  const stderr = new OutputLines();
  // 分片结果与 curl 错误共用 stderr；错误摘要只保留真正的诊断行。
  const errors: string[] = [];
  let blocked = 0;
  const onLine = (line: string) => {
    const transfer = parseTransfer(line);
    if (!transfer) {
      if (errors.length >= 20) errors.shift();
      errors.push(line);
      progress({ line });
      return;
    }
    if (transferAccepted(transfer)) {
      state.completed[transfer.file] = transfer.bytes;
      estimate.record(transfer.file, transfer.bytes);
      report();
      void save();
      return;
    }
    if (transfer.exitCode === 0 && transfer.contentType.startsWith("text/html")) {
      blocked++;
      // 拦截页不能留在分片位置，否则继续下载时会被当成已存在的文件。
      void quietly(files.remove(joinPath(root, transfer.file)));
    }
    if (failures.length < 1000) failures.push(transfer);
  };
  let result: ProcessResult;
  try {
    result = await context.run(
      context.curl,
      [
        "--disable",
        "--config",
        config,
        ...curlSafety,
        "--parallel",
        "--parallel-max",
        String(segmentParallel),
        "--remove-on-error",
        "--retry",
        "2",
        "--silent",
        "--show-error",
        "--write-out",
        transferFormat,
      ],
      signal,
      (chunk, stream) => {
        if (stream === "stderr") for (const line of stderr.push(chunk)) onLine(line);
      },
      true,
    );
  } finally {
    for (const line of stderr.finish()) onLine(line);
    await save(true);
    await quietly(files.remove(config));
  }
  signal.throwIfAborted();
  const missing = plan.files.filter((file) => !(file in state.completed)).length;
  if (!missing) return { result: { ...result, exitCode: 0 }, inputs };
  const first = failures.find((item) => item.exitCode) ?? failures[0];
  const exitCode = first?.exitCode || result.exitCode || 22;
  const reason = blocked
    ? `，其中 ${blocked} 个返回了网页，可能被网站拦截`
    : first?.status
      ? `，HTTP ${first.status}`
      : "";
  const hint = curlExitHint(exitCode);
  return {
    inputs: [],
    result: {
      // 保留 curl 的错误码，便于按网络错误决定是否改用代理。
      exitCode,
      stdOut: result.stdOut,
      stdErr: [`${missing} 个 HLS 分片未能下载${reason}。${hint}`, ...errors].join("\n"),
    },
  };
}
