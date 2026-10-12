import type { DownloadSettings, DownloadTask } from "../../contracts/downloads";
import type { DownloadEngine, DownloadProgress } from "./ports";
import { joinPath, redactLog } from "./input";
import { OutputLines, parseCurlProgress } from "./progress";
import { responseInfo } from "./http";
import type { HttpResumeInfo } from "./http";
import { keepTextTail } from "./text";
import type { ProcessRunner, ProcessResult } from "../../platform/neutralino/process";
import { canRetryWithProxy, curlExitHint } from "./network";
import type { MediaProbe } from "./probe";
import { downloadHls, mismatchedFiles, readHlsState } from "./hlsDownload";
import { configValue, curlContext, curlSafety } from "./curlConfig";
import { createHlsPlanner } from "./hlsPlanner";
import {
  imageSignature,
  isTransportStreamAt,
  transportStreamOffset,
  tsPacket,
  tsSyncPackets,
} from "./hls";

export interface DownloadFiles {
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile: boolean } | null>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  /** 从指定位置读取若干字节，用于诊断日志和识别伪装成图片的分片。 */
  readBytes?(path: string, length: number, position?: number): Promise<Uint8Array>;
  /** 写入二进制文件，例如 HLS 播放列表内嵌的密钥。 */
  writeBinary?(path: string, value: Uint8Array): Promise<void>;
  list(path: string): Promise<string[]>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeEmptyDirectory?(path: string): Promise<void>;
}
export interface DownloadHost {
  files: DownloadFiles;
  run: ProcessRunner;
  tool(name: "ffmpeg" | "curl", configured: string): Promise<string>;
  probe(path: string, signal: AbortSignal): Promise<MediaProbe>;
  defaultDirectory(): Promise<string>;
  open(path: string): Promise<void>;
  /** 创建 HLS 规划 Worker；未提供时（单元测试）在当前线程直接计算。 */
  hlsWorker?: () => Worker;
}
/**
 * 读取本地 HLS 播放列表的公共输入参数。探测范围放大到 200 MB / 120 秒：部分来源的首段不是
 * 关键帧，默认的 5 秒探测找不到视频参数，封装 MP4 时会报 “dimensions not set”。读取的是本地文件，代价很小。
 */
const hlsInputOptions = [
  "-allowed_extensions",
  "ALL",
  "-extension_picky",
  "0",
  "-protocol_whitelist",
  "file,crypto",
  "-probesize",
  "200M",
  "-analyzeduration",
  "120000000",
];
export class ToolDownloadEngine implements DownloadEngine {
  private decryption?: { path: string; supported: Promise<boolean> };
  constructor(
    private host: DownloadHost,
    private getProxy: () => Promise<string> = async () => "",
    /** 测试可缩短 HLS 自动补下载的等待时间，或传入空数组关闭。 */
    private options: { hlsRetryDelays?: number[]; hlsStallTimeout?: number } = {},
  ) {}
  /** 精简版 FFmpeg 只有启用 crypto 协议时才能在本地解密 AES-128 分片。 */
  private supportsDecryption(ffmpeg: string) {
    if (this.decryption?.path !== ffmpeg) {
      const supported = this.host
        .run(ffmpeg, ["-hide_banner", "-protocols"], AbortSignal.timeout(10000), undefined, true)
        .then((result) => result.exitCode === 0 && /^\s+crypto\s*$/m.test(result.stdOut));
      this.decryption = { path: ffmpeg, supported };
      supported.catch(() => {
        if (this.decryption?.supported === supported) this.decryption = undefined;
      });
    }
    return this.decryption.supported;
  }
  defaultDirectory() {
    return this.host.defaultDirectory();
  }
  async outputSize(path: string) {
    const stat = await this.host.files.stat(path);
    return stat?.isFile ? stat.size : null;
  }
  open(path: string) {
    return this.host.open(path);
  }
  async checkTools(settings: DownloadSettings) {
    const paths = await Promise.all([
      this.host.tool("ffmpeg", settings.ffmpegPath),
      this.host.tool("curl", settings.curlPath),
    ]);
    for (let i = 0; i < paths.length; i++) {
      const result = await this.host.run(
        paths[i]!,
        [i === 0 ? "-version" : "--version"],
        AbortSignal.timeout(10000),
        undefined,
        true,
      );
      if (result.exitCode !== 0) throw new Error(`工具启动失败：${paths[i]}`);
    }
    return paths;
  }
  private check(result: ProcessResult, label: string, task: DownloadTask, curl = false) {
    if (result.exitCode === 0) return;
    const detail = redactLog(keepTextTail(result.stdErr || result.stdOut, 2000), task);
    const hint = curl ? curlExitHint(result.exitCode) : "";
    // HLS 汇总里已经带有说明时不重复追加。
    const suffix = hint && !detail.includes(hint) ? ` ${hint}` : "";
    throw new Error(`${label}失败（退出码 ${result.exitCode}）：${detail}${suffix}`);
  }
  /**
   * 合并前确认本地播放列表引用的分片、密钥和初始化段都还在，且大小与下载时记录的一致。
   * 播放列表的拆分在规划器里完成，文件属性按有限并发异步读取。
   */
  private async playlistsReady(inputs: string[], signal: AbortSignal) {
    const planner = createHlsPlanner(this.host.hlsWorker);
    try {
      for (const input of inputs) {
        const stat = await this.host.files.stat(input);
        if (!stat?.isFile) return false;
        const directory = input.replace(/[\\/][^\\/]*$/, "");
        const text = await this.host.files.read(input);
        const { files: names } = await planner.run("files", { text }, signal);
        const recorded = (await readHlsState(this.host.files, directory))?.completed ?? {};
        if ((await mismatchedFiles(this.host.files, directory, names, recorded, signal)).length)
          return false;
      }
      return true;
    } finally {
      planner.close();
    }
  }
  /**
   * 合并前把本地播放列表的概况写入日志：分片、初始化段与密钥数量、时长，以及首个分片的
   * 大小和开头字节（判断是否为 TS、fMP4 或被替换成网页）。只记录本地文件名，不记录地址。
   */
  private async diagnoseHls(
    inputs: string[],
    signal: AbortSignal,
    progress: (update: DownloadProgress) => void,
  ) {
    const planner = createHlsPlanner(this.host.hlsWorker);
    let duration = 0;
    try {
      for (const [index, input] of inputs.entries()) {
        const text = await this.host.files.read(input);
        const inspected = await planner.run("files", { text }, signal);
        if (index === 0) duration = inspected.duration;
        const segments = inspected.files.filter((name) => name.includes("-seg-"));
        const maps = inspected.files.filter((name) => name.includes("-init-")).length;
        const keys = inspected.files.filter((name) => name.includes("-key-")).length;
        const name = input.split(/[\\/]/).at(-1);
        const directory = input.replace(/[\\/][^\\/]*$/, "");
        let first = "";
        const sample = inspected.files.find((item) => !item.includes("-key-"));
        if (sample) {
          const path = joinPath(directory, sample);
          const stat = await this.host.files.stat(path).catch(() => null);
          const bytes = await this.host.files.readBytes?.(path, 16).catch(() => undefined);
          const hex = bytes
            ? [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")
            : "未读取";
          first = `；首个文件 ${sample} 大小 ${stat?.size ?? "缺失"} 字节，开头 ${hex}`;
        }
        progress({
          line: `合并诊断：${name} 共 ${segments.length} 个分片、${maps} 个初始化段、${keys} 个密钥，时长 ${inspected.duration.toFixed(1)} 秒${first}。`,
        });
      }
    } finally {
      planner.close();
    }
    return duration;
  }
  /**
   * 伪装成图片的 TS 分片：在合并用的播放列表里给这些分片加上字节范围，跳过前面的图片头。
   * 只读取每个分片开头的少量字节（16 路并发异步），不改写分片文件，原播放列表保持不变。
   * 返回交给 FFmpeg 的播放列表路径；没有伪装时原样返回。
   */
  private async unwrapDisguisedSegments(
    inputs: string[],
    signal: AbortSignal,
    progress: (update: DownloadProgress) => void,
  ) {
    const files = this.host.files;
    const readBytes = files.readBytes?.bind(files);
    if (!readBytes) return inputs;
    const planner = createHlsPlanner(this.host.hlsWorker);
    try {
      const prepared: string[] = [];
      for (const input of inputs) {
        const directory = input.replace(/[\\/][^\\/]*$/, "");
        const name = input.split(/[\\/]/).at(-1)!;
        const text = await files.read(input);
        const { files: names } = await planner.run("files", { text }, signal);
        const segments = names.filter((item) => item.includes("-seg-"));
        const encrypted = names.some((item) => item.includes("-key-"));
        const recorded = (await readHlsState(files, directory))?.completed ?? {};
        const ranges: Record<string, { offset: number; length: number }> = {};
        const kinds = new Map<string, number>();
        let guess = -1;
        let unresolved = "";
        let next = 0;
        const inspect = async () => {
          while (next < segments.length && !unresolved) {
            signal.throwIfAborted();
            const segment = segments[next++]!;
            const path = joinPath(directory, segment);
            const kind = imageSignature(await readBytes(path, 16));
            if (!kind) continue;
            if (encrypted) {
              unresolved = `${segment} 是加密分片，却带有 ${kind} 图片头`;
              return;
            }
            const size = recorded[segment] ?? (await files.stat(path))?.size ?? 0;
            const window = (tsSyncPackets - 1) * tsPacket + 1;
            let offset = -1;
            // 同一来源的图片头通常长度相同，先验证上一个分片的偏移。
            if (guess > 0 && guess + window <= size)
              offset = isTransportStreamAt(await readBytes(path, window, guess), 0) ? guess : -1;
            for (const length of [64 * 1024, 1024 * 1024]) {
              if (offset >= 0) break;
              offset = transportStreamOffset(await readBytes(path, Math.min(length, size)));
            }
            if (offset <= 0) {
              unresolved = `${segment} 带有 ${kind} 图片头，但没有找到后面的视频数据`;
              return;
            }
            guess = offset;
            ranges[segment] = { offset, length: size - offset };
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
          }
        };
        await Promise.all(Array.from({ length: Math.min(16, segments.length) }, inspect));
        if (unresolved)
          throw new Error(`合并前检查失败：${unresolved}。该来源的分片格式暂不支持。`);
        const count = Object.keys(ranges).length;
        if (!count) {
          prepared.push(input);
          continue;
        }
        const offsets = new Set(Object.values(ranges).map((range) => range.offset));
        progress({
          line: `合并前处理：${name} 中 ${count} / ${segments.length} 个分片伪装成图片（${[...kinds].map(([kind, total]) => `${kind} ×${total}`).join("，")}），图片头长度 ${[...offsets].slice(0, 3).join("、")} 字节，已跳过图片头读取视频数据。`,
        });
        const output = joinPath(directory, name.replace(/\.m3u8$/, ".merge.m3u8"));
        await files.write(output, await planner.run("ranges", { text, ranges }, signal));
        prepared.push(output);
      }
      return prepared;
    } finally {
      planner.close();
    }
  }
  /** 合并失败后让 FFmpeg 只探测一次输入，把识别出的流信息写入日志。 */
  private async probeHlsStreams(
    ffmpeg: string,
    inputs: string[],
    signal: AbortSignal,
    progress: (update: DownloadProgress) => void,
  ) {
    const args = ["-hide_banner", "-nostdin", "-v", "info"];
    for (const path of inputs) args.push(...hlsInputOptions, "-i", path);
    try {
      const probe = await this.host.run(ffmpeg, args, signal, undefined, true);
      const details = probe.stdErr
        .split(/\r?\n/)
        .filter((line) =>
          /Input #|Duration:|Stream #|Could not|unspecified|Invalid|error/i.test(line),
        )
        .slice(0, 30);
      for (const line of details) progress({ line: `合并诊断（输入探测）：${line.trim()}` });
    } catch {
      // 诊断失败不影响原有的错误信息。
    }
  }
  private async cleanCompleted(task: DownloadTask, progress: (update: DownloadProgress) => void) {
    // The engine only owns this dedicated temporary directory, never its parent.
    if (task.workDirectory !== joinPath(task.directory, ".javm-download")) return;
    try {
      await this.host.files.remove(task.workDirectory);
    } catch {
      progress({ line: "视频已保存，临时目录清理失败，可在任务文件夹中手动清理。" });
    }
  }
  async discard(task: DownloadTask) {
    // 只删除引擎自有的临时目录；目标位置已有的同名文件可能不是本任务生成的。
    if (task.workDirectory === joinPath(task.directory, ".javm-download"))
      await this.host.files.remove(task.workDirectory);
    await this.host.files.removeEmptyDirectory?.(task.directory);
  }
  async run(
    task: DownloadTask,
    settings: DownloadSettings,
    signal: AbortSignal,
    progress: (update: DownloadProgress) => void,
    stage: (phase: DownloadTask["phase"], inputs?: string[]) => Promise<void>,
  ) {
    const files = this.host.files;
    const ffmpeg = await this.host.tool("ffmpeg", settings.ffmpegPath);
    signal.throwIfAborted();
    await files.mkdir(task.workDirectory);
    const existing = await files.stat(task.output);
    if (existing) {
      // A crash after the final rename but before DB commit is recoverable.
      if (task.phase === "merge") {
        const verified = await this.host.probe(task.output, signal);
        if (verified.video) {
          progress({ outputSize: existing.size });
          await this.cleanCompleted(task, progress);
          return;
        }
      }
      throw new Error("目标文件已经存在，已保留原文件。");
    }
    let inputs = task.inputs;
    let phase = task.phase;
    const localPlaylists = inputs.length > 0 && inputs.every((path) => path.endsWith(".m3u8"));
    if (
      phase === "merge" &&
      task.kind === "hls" &&
      localPlaylists &&
      !(await this.playlistsReady(inputs, signal))
    ) {
      // 临时分片被清理或部分丢失时回到下载阶段，只补齐缺失的文件。
      progress({ line: "合并所需的分片不完整，正在重新下载缺失部分。" });
      phase = "download";
    }
    if (phase === "download") {
      await stage("download");
      const curl = await this.host.tool("curl", settings.curlPath);
      const download = async (proxy: string) => {
        signal.throwIfAborted();
        if (task.kind === "hls") {
          // 每次尝试一个规划器，结束（包括取消和失败）时终止其 Worker。
          const planner = createHlsPlanner(this.host.hlsWorker);
          try {
            const hls = await downloadHls({
              task,
              curl,
              proxy,
              files,
              run: this.host.run,
              signal,
              progress,
              supportsDecryption: () => this.supportsDecryption(ffmpeg),
              retryDelays: this.options.hlsRetryDelays,
              stallTimeout: this.options.hlsStallTimeout,
              planner,
            });
            inputs = hls.inputs;
            return hls.result;
          } finally {
            planner.close();
          }
        }
        const stdout = new OutputLines();
        const stderr = new OutputLines();
        let previousBytes = 0;
        const onLine = (line: string) => {
          const update = parseCurlProgress(line);
          if (update && previousBytes) {
            if (update.downloaded !== undefined) update.downloaded += previousBytes;
            if (update.total) update.total += previousBytes;
            update.progress = update.total
              ? Math.min(100, ((update.downloaded || 0) / update.total) * 100)
              : null;
          }
          progress(update ?? { line });
        };
        const output = (chunk: string, stream: "stdout" | "stderr") => {
          for (const line of (stream === "stdout" ? stdout : stderr).push(chunk)) onLine(line);
        };
        let result: ProcessResult;
        const part = joinPath(task.workDirectory, "download.part");
        const headerPath = joinPath(task.workDirectory, "response.headers");
        const resumePath = joinPath(task.workDirectory, "resume.json");
        const previous = await files.stat(part);
        previousBytes = previous?.size || 0;
        let resume: HttpResumeInfo | undefined;
        let response: HttpResumeInfo | undefined;
        const lines = [
          `url = ${configValue(task.url)}`,
          `output = ${configValue(part)}`,
          `dump-header = ${configValue(headerPath)}`,
          ...curlContext(task, proxy),
        ];
        if (previousBytes) {
          if (await files.stat(resumePath))
            resume = JSON.parse(await files.read(resumePath)) as HttpResumeInfo;
          else if (await files.stat(headerPath))
            resume = responseInfo(await files.read(headerPath));
          if (resume?.validator)
            lines.push(`header = ${configValue(`If-Range: ${resume.validator}`)}`);
        }
        const configPath = joinPath(task.workDirectory, "request.curl");
        await files.write(configPath, lines.join("\n"));
        try {
          result = await this.host.run(
            curl,
            ["--disable", "--config", configPath, ...curlSafety, "--continue-at", "-"],
            signal,
            output,
            true,
          );
        } finally {
          await files.remove(configPath);
          // Preserve successful response validators even when a later retry gets
          // a 403/5xx response or a user pauses mid transfer.
          if (await files.stat(headerPath)) {
            const info = responseInfo(await files.read(headerPath));
            response = info;
            if (
              (info.status === 200 || info.status === 206) &&
              (!resume?.validator || resume.validator === info.validator)
            ) {
              await files.write(resumePath, JSON.stringify(info));
            }
          }
        }
        signal.throwIfAborted();
        if (result.exitCode === 33 || (result.exitCode === 22 && response?.status === 416))
          throw new Error(
            "服务器不支持本次续传或资源已变化，已保留临时文件。请停止原任务后重新新建下载。",
          );
        if (result.exitCode === 0) {
          const info = responseInfo(await files.read(headerPath));
          if (resume?.validator && info.validator && resume.validator !== info.validator)
            throw new Error("远端文件已经变化，请停止原任务后重新新建下载。");
          const actual = await files.stat(part);
          if (info.total && actual?.size !== info.total)
            throw new Error("下载字节数与服务器声明不符，已保留临时文件。");
        }
        inputs = [part];
        for (const line of [...stdout.finish(), ...stderr.finish()]) onLine(line);
        signal.throwIfAborted();
        return result;
      };
      progress({ line: "正在尝试直连下载。" });
      let result = await download("");
      let usedProxy = false;
      if (canRetryWithProxy(result)) {
        const proxy = await this.getProxy();
        signal.throwIfAborted();
        if (proxy) {
          usedProxy = true;
          progress({ line: "直连失败，正在通过网络代理重试。", progress: null, speed: 0 });
          result = await download(proxy);
        }
      }
      signal.throwIfAborted();
      this.check(result, usedProxy ? "代理下载" : "直连下载", task, true);
      if (!inputs.length) throw new Error("下载器没有生成可合并的媒体文件。");
      if (task.kind === "http") {
        let downloaded = 0;
        for (const path of inputs) {
          const stat = await files.stat(path);
          if (!stat?.isFile || stat.size <= 0) throw new Error("下载文件缺失或为空，请重试。");
          downloaded += stat.size;
        }
        progress({ downloaded, total: downloaded, totalIsEstimate: false, progress: 100 });
      }
    }
    signal.throwIfAborted();
    await stage("merge", inputs);
    const outputPath = joinPath(task.workDirectory, "merged.partial.mp4");
    const args = ["-hide_banner", "-nostdin", "-y", "-v", "error"];
    const hlsMerge = inputs.every((path) => path.endsWith(".m3u8"));
    // 合并实际使用的输入；伪装分片会换成带字节范围的副本，任务记录里的输入保持不变。
    let mergeInputs = inputs;
    let duration: number;
    let requireAudio: boolean;
    if (inputs.every((path) => path.endsWith(".m3u8"))) {
      // 本地播放列表只引用本任务目录中的分片与密钥文件。HLS 解复用器在独立 TS 音轨开头
      // 会给出重复的时间戳，FFmpeg 平时自行修正；-xerror 会把它变成致命错误，因此这里不用。
      // 输出仍需通过下方的视频、音频与时长校验。
      // 大播放列表的拆分与时长合计在规划 Worker 中完成。
      duration = await this.diagnoseHls(inputs, signal, progress);
      mergeInputs = await this.unwrapDisguisedSegments(inputs, signal, progress);
      requireAudio = inputs.length > 1;
      // 警告级别会把探测与时间戳问题写进日志，便于排查合并失败。
      args[4] = "warning";
      for (const path of mergeInputs) args.push(...hlsInputOptions, "-i", path);
      args.push("-map", "0:v:0", "-map", requireAudio ? "1:a:0" : "0:a:0?");
    } else {
      // 旧版下载器留下的源轨文件仍按探测结果合并，并保留严格模式。
      args.push("-xerror");
      const probes: MediaProbe[] = [];
      for (const path of inputs) probes.push(await this.host.probe(path, signal));
      const videoIndex = probes.findIndex((probe) => probe.video);
      if (videoIndex === -1) throw new Error("下载结果没有视频轨道，请检查链接或资源类型。");
      const audioIndex = probes.findIndex((probe) => probe.audio);
      duration = probes[videoIndex]!.durationMs / 1000;
      requireAudio = audioIndex >= 0;
      for (const path of inputs) args.push("-i", path);
      args.push("-map", `${videoIndex}:v:0`);
      if (audioIndex >= 0) args.push("-map", `${audioIndex}:a:0`);
    }
    args.push(
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-nostats",
      "-f",
      "mp4",
      outputPath,
    );
    const lines = new OutputLines();
    const merged = await this.host.run(
      ffmpeg,
      args,
      signal,
      (chunk, stream) => {
        if (stream === "stderr") {
          progress({ line: chunk });
          return;
        }
        for (const line of lines.push(chunk)) {
          const match = /^out_time_us=(\d+)$/.exec(line);
          if (match && duration)
            progress({ progress: Math.min(99, Number(match[1]) / 10000 / duration) });
        }
      },
      true,
    );
    signal.throwIfAborted();
    if (merged.exitCode !== 0 && hlsMerge) {
      await this.probeHlsStreams(ffmpeg, mergeInputs, signal, progress);
      if (
        /dimensions not set|Could not find codec parameters|unspecified size/i.test(merged.stdErr)
      )
        merged.stdErr +=
          "\n视频开头一段内没有找到可识别的视频参数（关键帧），或分片内容不是有效视频。可尝试重新下载；如果仍失败，请把应用日志发给开发者。";
    }
    this.check(merged, "合并", task);
    const stat = await files.stat(outputPath);
    if (!stat?.isFile || !stat.size) throw new Error("合并没有生成有效输出，已保留下载文件。");
    const verified = await this.host.probe(outputPath, signal);
    if (!verified.video) throw new Error("合并输出缺少视频轨道。");
    if (requireAudio && !verified.audio) throw new Error("合并输出缺少音频轨道。");
    const finalDuration = verified.durationMs / 1000;
    if (duration > 0 && finalDuration < duration - Math.max(1, duration * 0.01))
      throw new Error("合并输出时长不完整，已保留下载文件。");
    if (await files.stat(task.output)) throw new Error("目标文件已存在，已保留合并结果。");
    signal.throwIfAborted();
    await files.move(outputPath, task.output);
    await this.cleanCompleted(task, progress);
    progress({ progress: 100, outputSize: stat.size, line: "视频已合并并保存。" });
  }
}
