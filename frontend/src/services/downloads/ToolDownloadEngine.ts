import type { DownloadSettings, DownloadTask } from "../../contracts/downloads";
import type { DownloadEngine, DownloadProgress } from "./ports";
import { joinPath, redactLog } from "./input";
import { HlsOutput, HlsProgress, OutputLines, parseCurlProgress } from "./progress";
import { responseInfo } from "./http";
import type { HttpResumeInfo } from "./http";
import { keepTextTail } from "./text";
import type { ProcessRunner, ProcessResult } from "../../platform/neutralino/process";
import { canRetryWithProxy } from "./network";
import type { MediaProbe } from "./probe";

export interface DownloadFiles {
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile: boolean } | null>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  list(path: string): Promise<string[]>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface DownloadHost {
  files: DownloadFiles;
  run: ProcessRunner;
  tool(name: "N_m3u8DL-RE" | "ffmpeg" | "curl", configured: string): Promise<string>;
  probe(path: string, signal: AbortSignal): Promise<MediaProbe>;
  defaultDirectory(): Promise<string>;
  open(path: string): Promise<void>;
}
const configValue = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;

export class ToolDownloadEngine implements DownloadEngine {
  constructor(
    private host: DownloadHost,
    private getProxy: () => Promise<string> = async () => "",
  ) {}
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
    const ffmpeg = await this.host.tool("ffmpeg", settings.ffmpegPath);
    const paths = await Promise.all([
      this.host.tool("N_m3u8DL-RE", settings.hlsPath),
      Promise.resolve(ffmpeg),
      this.host.tool("curl", settings.curlPath),
    ]);
    for (let i = 0; i < paths.length; i++) {
      const result = await this.host.run(
        paths[i]!,
        [i === 1 ? "-version" : "--version"],
        AbortSignal.timeout(10000),
        undefined,
        true,
      );
      if (result.exitCode !== 0) throw new Error(`工具启动失败：${paths[i]}`);
    }
    return paths;
  }
  private check(result: ProcessResult, label: string, task: DownloadTask) {
    if (result.exitCode !== 0)
      throw new Error(
        `${label}失败（退出码 ${result.exitCode}）：${redactLog(keepTextTail(result.stdErr || result.stdOut, 2000), task)}`,
      );
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
    if (task.phase === "download") {
      await stage("download");
      const download = async (proxy: string) => {
        signal.throwIfAborted();
        const stdout = task.kind === "hls" ? new HlsOutput() : new OutputLines();
        const stderr = task.kind === "hls" ? new HlsOutput() : new OutputLines();
        const hlsProgress = new HlsProgress();
        let previousBytes = 0;
        const onLine = (line: string) => {
          const update = task.kind === "hls" ? hlsProgress.push(line) : parseCurlProgress(line);
          if (update && task.kind === "http" && previousBytes) {
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
        if (task.kind === "hls") {
          const downloader = await this.host.tool("N_m3u8DL-RE", settings.hlsPath);
          // 分片继续复用；源轨按尝试隔离，避免下载器重命名后选中旧的半成品。
          const sourceDirectory = joinPath(
            task.workDirectory,
            `${proxy ? "source-proxy" : "source"}-${crypto.randomUUID()}`,
          );
          await files.mkdir(sourceDirectory);
          const args = [
            task.url,
            "--save-dir",
            sourceDirectory,
            "--save-name",
            "media",
            "--tmp-dir",
            joinPath(task.workDirectory, "segments"),
            // Auto-select chooses one audio per language. This task produces one
            // audio track, so select it explicitly instead of relying on file order.
            "--select-video",
            "best",
            "--select-audio",
            "best",
            "--drop-subtitle",
            "all",
            "--thread-count",
            "8",
            "--download-retry-count",
            "3",
            "--http-request-timeout",
            "60",
            "--binary-merge",
            "--del-after-done",
            "false",
            "--no-ansi-color",
            "--no-log",
            "--write-meta-json",
            "false",
            "--disable-update-check",
            "--ui-language",
            "en-US",
            "--use-system-proxy",
            "false",
            "--ffmpeg-binary-path",
            ffmpeg,
          ];
          for (const [key, value] of Object.entries(task.headers))
            args.push("-H", `${key}: ${value}`);
          // .NET's SOCKS5 implementation resolves hostnames through the proxy.
          if (proxy) args.push("--custom-proxy", proxy.replace(/^socks5h:/i, "socks5:"));
          result = await this.host.run(downloader, args, signal, output, true);
          inputs = (await files.list(sourceDirectory)).filter((path) =>
            /\.(ts|mp4|m4a|aac|mkv|m4s|ec3|eac3|ac3)$/i.test(path),
          );
        } else {
          const downloader = await this.host.tool("curl", settings.curlPath);
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
            `proxy = ${configValue(proxy)}`,
            // Override inherited HTTP(S)_PROXY and NO_PROXY in both phases.
            `noproxy = ${configValue(proxy ? "" : "*")}`,
          ];
          for (const [key, value] of Object.entries(task.headers))
            lines.push(`header = ${configValue(`${key}: ${value}`)}`);
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
              downloader,
              [
                "--disable",
                "--config",
                configPath,
                "--location",
                "--proto",
                "=http,https",
                "--proto-redir",
                "=http,https",
                "--fail",
                "--connect-timeout",
                "20",
                "--speed-time",
                "60",
                "--speed-limit",
                "1",
                "--continue-at",
                "-",
              ],
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
        }
        for (const line of [...stdout.finish(), ...stderr.finish()]) onLine(line);
        signal.throwIfAborted();
        return result;
      };
      progress({ line: "正在尝试直连下载。" });
      let result = await download("");
      let usedProxy = false;
      if (canRetryWithProxy(task.kind, result)) {
        const proxy = await this.getProxy();
        signal.throwIfAborted();
        if (proxy) {
          usedProxy = true;
          progress({ line: "直连失败，正在通过网络代理重试。", progress: null, speed: 0 });
          result = await download(proxy);
        }
      }
      signal.throwIfAborted();
      this.check(result, usedProxy ? "代理下载" : "直连下载", task);
      if (!inputs.length) throw new Error("下载器没有生成可合并的媒体文件。");
      let downloaded = 0;
      for (const path of inputs) {
        const stat = await files.stat(path);
        if (!stat?.isFile || stat.size <= 0) throw new Error("下载文件缺失或为空，请重试。");
        downloaded += stat.size;
      }
      progress({ downloaded, total: downloaded, totalIsEstimate: false, progress: 100 });
    }
    signal.throwIfAborted();
    await stage("merge", inputs);
    const probes: MediaProbe[] = [];
    for (const path of inputs) probes.push(await this.host.probe(path, signal));
    const videoIndex = probes.findIndex((probe) => probe.video);
    if (videoIndex === -1) throw new Error("下载结果没有视频轨道，请检查链接或资源类型。");
    const audioIndex = probes.findIndex((probe) => probe.audio);
    const duration = probes[videoIndex]!.durationMs / 1000;
    const outputPath = joinPath(task.workDirectory, "merged.partial.mp4");
    const args = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-xerror"];
    for (const path of inputs) args.push("-i", path);
    args.push("-map", `${videoIndex}:v:0`);
    if (audioIndex >= 0) args.push("-map", `${audioIndex}:a:0`);
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
    if (audioIndex >= 0 && !verified.audio) throw new Error("合并输出缺少音频轨道。");
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
