import type { DownloadTask } from "../../contracts/downloads";
import type { ProcessResult, ProcessRunner } from "../../platform/neutralino/process";
import type { DownloadProgress } from "./ports";
import type { DownloadFiles } from "./ToolDownloadEngine";
import { joinPath } from "./input";
import { OutputLines } from "./progress";
import { curlExitHint, isNetworkFailure } from "./network";
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

/** 单任务内的初始分片并发；任务之间的并发由下载服务的队列控制。 */
const segmentParallel = 8;
/** 连续这么久没有任何分片完成（成功或失败）就视为停滞，结束本轮并降低并发。 */
export const defaultStallTimeout = 90_000;
/** 下载过程中写入进度日志的间隔。 */
const progressLogInterval = 30_000;
/** 每轮最多写入日志的 curl 诊断行数，其余只保留在错误摘要里。 */
const roundLogLimit = 50;
/** 核对本地文件大小时同时进行的文件属性请求数。 */
const statParallel = 16;
/** 一轮下载后仍有分片缺失时，自动补下载的等待时间（毫秒）；数组长度即自动重试轮数。 */
export const defaultRetryDelays = [2000, 5000, 10000];
type Transfer = NonNullable<ReturnType<typeof parseTransfer>>;
/**
 * 偶发错误值得再试：网络错误、超时，以及 403/408/425/429、5xx 等 HTTP 错误。
 * 404、410、无效密钥，以及磁盘写入（23）等本地错误是永久性的，再试也不会成功。
 */
const retryable = (item: Transfer) =>
  item.exitCode === 22
    ? ![400, 401, 404, 405, 410, 451].includes(item.status)
    : isNetworkFailure(item.exitCode);
/** 按原因汇总失败分片，写入日志与界面提示。 */
export function describeFailures(failures: Transfer[]) {
  const counts = new Map<string, number>();
  for (const item of failures) {
    const reason =
      item.status >= 400
        ? `HTTP ${item.status}`
        : item.exitCode
          ? `curl ${item.exitCode}`
          : item.contentType.startsWith("text/html")
            ? "返回网页"
            : "内容无效";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => `${reason} ×${count}`).join("，") || "原因未知";
}
/** 可取消的等待。 */
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
  });
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
  /** 自动补下载的等待时间；省略时使用 defaultRetryDelays，测试可缩短或关闭。 */
  retryDelays?: number[];
  /** 停滞判定时间；省略时使用 defaultStallTimeout，测试可缩短。 */
  stallTimeout?: number;
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
  const retryDelays = context.retryDelays ?? defaultRetryDelays;
  const stallTimeout = context.stallTimeout ?? defaultStallTimeout;
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
  // 记录有版本号；内容没有变化时不重复写盘。
  let writing: Promise<void> | undefined;
  let queued = false;
  let lastSaved = 0;
  let version = 1;
  let written = 0;
  const flush = async () => {
    while (queued) {
      queued = false;
      if (version === written) continue;
      const current = version;
      const snapshot = JSON.stringify(state);
      const temporary = `${statePath}.tmp`;
      await quietly(
        files.write(temporary, snapshot).then(async () => {
          await files.move(temporary, statePath);
          written = current;
        }),
      );
    }
  };
  const save = (force = false) => {
    if (version === written && !writing) return Promise.resolve();
    if (!force && performance.now() - lastSaved < 2000) return writing ?? Promise.resolve();
    lastSaved = performance.now();
    queued = true;
    writing ??= flush().finally(() => {
      writing = undefined;
    });
    return writing;
  };

  report();
  let result: ProcessResult = { exitCode: 0, stdOut: "", stdErr: "" };
  let failures: Transfer[] = [];
  let errors: string[] = [];
  let blocked = 0;
  let invalidKeys = 0;
  // 部分源站限制单个 IP 的并发连接，多出的连接会被挂起不回应；遇到停滞或大量超时就逐轮减半。
  let parallel = segmentParallel;
  for (let round = 0; round <= retryDelays.length; round++) {
    // 均匀取样的顺序与 curl 清单都在规划器里生成，让早期估算覆盖整部影片。
    const segments = await planner.run(
      "config",
      { head: curlContext(task, context.proxy), root, completed: Object.keys(state.completed) },
      signal,
    );
    if (!segments.pending) break;
    if (round) {
      const delay = retryDelays[round - 1]!;
      progress({
        line: `第 ${round} 次自动重试：${segments.pending} 个分片未完成（${describeFailures(failures)}），${delay / 1000} 秒后以并发 ${parallel} 重新下载。`,
      });
      await wait(delay, signal);
    } else progress({ line: `正在下载 ${segments.pending} / ${total} 个 HLS 分片。` });
    const before = Object.keys(state.completed).length;
    const outcome = await downloadRound(segments.config, segments.pending, parallel);
    result = outcome.result;
    failures = outcome.failures;
    errors = outcome.errors;
    blocked = outcome.blocked;
    invalidKeys = outcome.invalidKeys;
    signal.throwIfAborted();
    const advanced = Object.keys(state.completed).length > before;
    if (
      parallel > 1 &&
      (outcome.stalled || outcome.timeouts >= Math.max(2, Math.ceil(parallel / 2)))
    ) {
      parallel = Math.max(1, Math.floor(parallel / 2));
      progress({
        line: outcome.stalled
          ? `连续 ${(stallTimeout / 1000).toFixed(0)} 秒没有分片完成，源站可能限制了并发连接，下一轮并发降为 ${parallel}。`
          : `本轮有 ${outcome.timeouts} 个连接超时，源站可能限制了并发连接，下一轮并发降为 ${parallel}。`,
      });
    }
    // 没有进展且都是永久性错误（404、410、密钥无效）时，再试也不会成功；停滞总是值得再试。
    if (!advanced && !outcome.stalled && !failures.some(retryable)) break;
  }
  // 内嵌密钥等不经 curl 的文件也要落盘记录，合并前核对依赖这份记录。
  await save(true);
  const missing = plan.files.filter((file) => !(file in state.completed)).length;
  if (!missing) return { result: { ...result, exitCode: 0 }, inputs };
  const first = failures.find((item) => item.exitCode) ?? failures[0];
  const exitCode = first?.exitCode || result.exitCode || 22;
  const reason = invalidKeys
    ? "，解密密钥无效（不是 16 字节），可能被网站拦截"
    : blocked
      ? `，其中 ${blocked} 个返回了网页，可能被网站拦截`
      : failures.length
        ? `（${describeFailures(failures)}）`
        : "";
  const hint = curlExitHint(exitCode);
  return {
    inputs: [],
    result: {
      // 保留 curl 的错误码，便于按网络错误决定是否改用代理。
      exitCode,
      stdOut: result.stdOut,
      stdErr: [
        `已自动重试 ${retryDelays.length} 次，仍有 ${missing} 个 HLS 分片未能下载${reason}。${hint}`,
        ...errors,
      ].join("\n"),
    },
  };

  async function downloadRound(list: string, pending: number, parallel: number) {
    const config = joinPath(root, "segments.curl");
    await files.write(config, list);
    const failures: Transfer[] = [];
    const stderr = new OutputLines();
    // 分片结果与 curl 错误共用 stderr；错误摘要只保留真正的诊断行。
    const errors: string[] = [];
    let blocked = 0,
      invalidKeys = 0,
      timeouts = 0,
      finished = 0,
      succeeded = 0,
      logged = 0,
      stalled = false;
    let lastActivity = performance.now();
    const onLine = (line: string) => {
      const transfer = parseTransfer(line);
      if (!transfer) {
        if (errors.length >= 20) errors.shift();
        errors.push(line);
        if (logged < roundLogLimit) progress({ line });
        else if (logged === roundLogLimit)
          progress({ line: "本轮 curl 诊断信息较多，其余内容不再写入日志。" });
        logged++;
        return;
      }
      lastActivity = performance.now();
      finished++;
      if (transfer.exitCode === 28) timeouts++;
      // AES-128 密钥固定 16 字节；其他长度说明拿到的是错误页或被替换的内容。
      const keyFile = transfer.file.includes("-key-");
      if (transferAccepted(transfer) && (!keyFile || transfer.bytes === 16)) {
        state.completed[transfer.file] = transfer.bytes;
        succeeded++;
        version++;
        estimate.record(transfer.file, transfer.bytes);
        report();
        void save();
        return;
      }
      if (keyFile && transfer.exitCode === 0) {
        invalidKeys++;
        void quietly(files.remove(joinPath(root, transfer.file)));
        if (failures.length < 1000) failures.push({ ...transfer, status: 0, exitCode: 0 });
        return;
      }
      if (transfer.exitCode === 0 && transfer.contentType.startsWith("text/html")) {
        blocked++;
        // 拦截页不能留在分片位置，否则继续下载时会被当成已存在的文件。
        void quietly(files.remove(joinPath(root, transfer.file)));
      }
      if (failures.length < 1000) failures.push(transfer);
    };
    // 停滞看门狗：长时间没有任何分片结束时只结束本轮 curl，不影响用户的暂停与取消。
    const stall = new AbortController();
    const started = performance.now();
    let lastLog = started;
    const watchdog = setInterval(
      () => {
        const now = performance.now();
        if (now - lastLog >= progressLogInterval) {
          lastLog = now;
          progress({
            line: `进度：本轮 ${finished} / ${pending} 个分片已结束（成功 ${succeeded}，失败 ${finished - succeeded}），全部已完成 ${Object.keys(state.completed).length} / ${total}，并发 ${parallel}。`,
          });
        }
        if (now - lastActivity >= stallTimeout && !stall.signal.aborted) {
          stalled = true;
          stall.abort(new Error("stalled"));
        }
      },
      Math.min(5000, Math.max(50, stallTimeout / 4)),
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
          "--parallel",
          "--parallel-max",
          String(parallel),
          "--remove-on-error",
          // 单个分片的即时重试：连接重置、403/5xx 等偶发错误也重试，总时长有上限。
          "--retry",
          "3",
          "--retry-delay",
          "1",
          "--retry-all-errors",
          "--retry-max-time",
          "120",
          // 不显示进度条，但保留重试提示与错误，便于从日志判断源站行为。
          "--no-progress-meter",
          "--write-out",
          transferFormat,
        ],
        AbortSignal.any([signal, stall.signal]),
        (chunk, stream) => {
          if (stream === "stderr") for (const line of stderr.push(chunk)) onLine(line);
        },
        true,
      );
    } catch (error) {
      // 看门狗结束的是本轮 curl；用户取消仍按原样抛出。
      if (signal.aborted || !stalled) throw error;
      result = { exitCode: 28, stdOut: "", stdErr: "" };
    } finally {
      clearInterval(watchdog);
      for (const line of stderr.finish()) onLine(line);
      await save(true);
      await quietly(files.remove(config));
    }
    if (stalled) {
      errors.push(`连续 ${(stallTimeout / 1000).toFixed(0)} 秒没有分片完成，已结束本轮下载。`);
      if (result.exitCode === 0 || result.exitCode === -1) result = { ...result, exitCode: 28 };
    }
    return { result, failures, errors, blocked, invalidKeys, timeouts, stalled };
  }
}
