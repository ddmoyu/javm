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

export interface DownloadFiles {
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile: boolean } | null>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
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
export class ToolDownloadEngine implements DownloadEngine {
  private decryption?: { path: string; supported: Promise<boolean> };
  constructor(
    private host: DownloadHost,
    private getProxy: () => Promise<string> = async () => "",
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
    let duration: number;
    let requireAudio: boolean;
    if (inputs.every((path) => path.endsWith(".m3u8"))) {
      // 本地播放列表只引用本任务目录中的分片与密钥文件。HLS 解复用器在独立 TS 音轨开头
      // 会给出重复的时间戳，FFmpeg 平时自行修正；-xerror 会把它变成致命错误，因此这里不用。
      // 输出仍需通过下方的视频、音频与时长校验。
      // 大播放列表的拆分与时长合计在规划 Worker 中完成。
      const planner = createHlsPlanner(this.host.hlsWorker);
      try {
        const text = await files.read(inputs[0]!);
        duration = (await planner.run("files", { text }, signal)).duration;
      } finally {
        planner.close();
      }
      requireAudio = inputs.length > 1;
      for (const path of inputs)
        args.push(
          "-allowed_extensions",
          "ALL",
          "-extension_picky",
          "0",
          "-protocol_whitelist",
          "file,crypto",
          "-i",
          path,
        );
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
