import { describe, expect, it } from "vite-plus/test";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { finished } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolDownloadEngine } from "../frontend/src/services/downloads/ToolDownloadEngine";
import type { DownloadHost } from "../frontend/src/services/downloads/ToolDownloadEngine";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type { DownloadProgress } from "../frontend/src/services/downloads/ports";
import { processCommand } from "../frontend/src/platform/neutralino/process";
import type { ProcessRunner } from "../frontend/src/platform/neutralino/process";
import { MediaHost } from "./helpers/mediaHost";
import { createMediaProbe } from "../frontend/src/services/downloads/probe";

// Explicit opt-in: these are full external downloads, not part of ordinary CI.
const enabled =
  process.platform === "win32" && process.env.JAVM_PUBLIC_DOWNLOAD_INTEGRATION === "1";
const streams = [
  ["bbb-master", "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"],
  ["bbb-480p", "https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8"],
  ["tears-of-steel", "https://test-streams.mux.dev/tos_ismc/main.m3u8"],
  ["sintel", "https://cdn.bitmovin.com/content/assets/streams-sample-video/sintel/m3u8/index.m3u8"],
  ["angel-one", "https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8"],
] as const;
const workspace = fileURLToPath(new URL("../", import.meta.url));
const root = path.join(workspace, ".tmp", "public-hls-review", "run-" + Date.now());
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(operation: () => Promise<T>) {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await operation();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
function locate(name: string) {
  return execFileSync("where.exe", [name + ".exe"], { encoding: "utf8", windowsHide: true })
    .trim()
    .split(/\r?\n/)[0]!;
}

describe.runIf(enabled)("user supplied public HLS streams", () => {
  it.concurrent.each(streams)(
    "downloads and validates %s",
    async (name, url) =>
      slot(async () => {
        const capture = path.join(root, name);
        await fs.mkdir(capture, { recursive: true });
        const started = Date.now();
        let sequence = 0;
        let phase = "preparing";
        let latest: DownloadProgress = {};
        let progressUpdates = 0;
        let liveSizeUpdates = 0;
        let firstSizeMs: number | null = null;
        let firstProgressMs: number | null = null;
        let unknownProgressWithBytes = 0;
        let maxProgressCallbackMs = 0;
        const samples: { ms: number; phase: string; update: DownloadProgress }[] = [];
        let lastSample = 0;
        const tools: Record<string, string> = {
          ffmpeg: process.env.JAVM_FFMPEG || locate("ffmpeg"),
          curl: locate("curl"),
          "N_m3u8DL-RE": path.join(workspace, "bin", "tools", "N_m3u8DL-RE.exe"),
        };
        const media = new MediaHost();
        await media.start(path.join(capture, "probe.sqlite3"));
        const run: ProcessRunner = async (file, args, signal, output) => {
          signal.throwIfAborted();
          const prefix = String(++sequence).padStart(2, "0") + "-" + path.basename(file);
          await fs.writeFile(
            path.join(capture, prefix + ".args.json"),
            JSON.stringify(args, null, 2),
          );
          const rawOut = createWriteStream(path.join(capture, prefix + ".stdout.log"));
          const rawErr = createWriteStream(path.join(capture, prefix + ".stderr.log"));
          const [command, ...encoded] = processCommand(file, args).split(" ");
          const child = spawn(command!, encoded, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.pipe(rawOut);
          child.stderr.pipe(rawErr);
          let stdOut = "";
          let stdErr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdOut = (stdOut + chunk).slice(-65536);
            const before = performance.now();
            output?.(chunk, "stdout");
            maxProgressCallbackMs = Math.max(maxProgressCallbackMs, performance.now() - before);
          });
          child.stderr.on("data", (chunk: string) => {
            stdErr = (stdErr + chunk).slice(-65536);
            output?.(chunk, "stderr");
          });
          const abort = () => {
            if (child.pid) {
              const kill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
                windowsHide: true,
                stdio: "ignore",
              });
              kill.on("error", () => {});
            }
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          let exitCode: number;
          try {
            exitCode = await new Promise<number>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) => resolve(code ?? -1));
            });
          } finally {
            signal.removeEventListener("abort", abort);
            await Promise.all([finished(rawOut), finished(rawErr)]);
          }
          signal.throwIfAborted();
          return { exitCode, stdOut, stdErr };
        };
        const host: DownloadHost = {
          run,
          probe: createMediaProbe(media.request.bind(media)),
          async tool(tool) {
            return tools[tool]!;
          },
          async defaultDirectory() {
            return capture;
          },
          async open() {},
          files: {
            async mkdir(folder) {
              await fs.mkdir(folder, { recursive: true });
            },
            async stat(file) {
              try {
                const info = await fs.stat(file);
                return { size: info.size, isFile: info.isFile() };
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
              }
            },
            read: (file) => fs.readFile(file, "utf8"),
            write: (file, value) => fs.writeFile(file, value, "utf8"),
            async list(folder) {
              return (await fs.readdir(folder, { withFileTypes: true }))
                .filter((entry) => entry.isFile())
                .map((entry) => path.join(folder, entry.name));
            },
            move: fs.rename,
            async remove(file) {
              const resolved = path.resolve(file);
              if (!resolved.startsWith(capture + path.sep))
                throw new Error("Public download cleanup outside its isolated directory");
              await fs.rm(resolved, { recursive: true, force: true });
            },
          },
        };
        const task = createDownloadTasks(
          { urls: [url], name, directory: capture, kind: "hls", headers: {} },
          [],
        )[0]!;
        const signal = AbortSignal.timeout(15 * 60 * 1000);
        const timer = setInterval(() => {
          console.info(JSON.stringify({ name, phase, ...latest }));
        }, 20000);
        console.info("Public HLS capture: " + capture);
        try {
          await new ToolDownloadEngine(host).run(
            task,
            defaultDownloadSettings,
            signal,
            (update) => {
              const { line: _line, ...stats } = update;
              Object.assign(task, stats);
              latest = { ...latest, ...stats };
              if (stats.progress !== undefined) progressUpdates++;
              if (phase === "download" && stats.progress! > 0)
                firstProgressMs ??= Date.now() - started;
              if (stats.downloaded! > 0 && stats.progress === null) unknownProgressWithBytes++;
              if (phase === "download" && stats.total! > 0 && stats.progress! < 100) {
                liveSizeUpdates++;
                firstSizeMs ??= Date.now() - started;
              }
              if (Date.now() - lastSample >= 1000 || stats.outputSize) {
                lastSample = Date.now();
                samples.push({ ms: Date.now() - started, phase, update });
              }
            },
            async (value, inputs) => {
              phase = value;
              task.phase = value;
              if (inputs) task.inputs = inputs;
            },
          );
          const result = await host.probe(task.output, signal);
          expect(result.video).toBe(true);
          expect(result.audio).toBe(true);
          expect(result.durationMs).toBeGreaterThan(10000);
          expect(task.outputSize).toBe((await fs.stat(task.output)).size);
          expect(liveSizeUpdates).toBeGreaterThan(0);
          expect(unknownProgressWithBytes).toBe(0);
          expect(result.audioTracks).toBe(1);
          if (name === "angel-one") {
            expect(result.audioChannels).toBe(6);
            expect(["en", "eng"]).toContain(result.audioLanguage);
          }
          await fs.writeFile(
            path.join(capture, "result.json"),
            JSON.stringify(
              {
                name,
                url,
                completed: true,
                elapsedMs: Date.now() - started,
                progressUpdates,
                liveSizeUpdates,
                firstSizeMs,
                firstProgressMs,
                unknownProgressWithBytes,
                maxProgressCallbackMs,
                output: task.output,
                probe: result,
                samples,
              },
              null,
              2,
            ),
          );
          console.info(
            JSON.stringify({ name, completed: true, bytes: task.outputSize, firstSizeMs }),
          );
        } catch (error) {
          await fs.writeFile(
            path.join(capture, "result.json"),
            JSON.stringify(
              {
                name,
                url,
                completed: false,
                phase,
                elapsedMs: Date.now() - started,
                progressUpdates,
                liveSizeUpdates,
                firstSizeMs,
                firstProgressMs,
                unknownProgressWithBytes,
                maxProgressCallbackMs,
                error: String(error),
                samples,
              },
              null,
              2,
            ),
          );
          throw error;
        } finally {
          clearInterval(timer);
          await media.close();
        }
      }),
    35 * 60 * 1000,
  );
});
