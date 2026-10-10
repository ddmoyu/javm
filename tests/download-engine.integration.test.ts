import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolDownloadEngine } from "../frontend/src/services/downloads/ToolDownloadEngine";
import type { DownloadHost } from "../frontend/src/services/downloads/ToolDownloadEngine";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type { DownloadTask } from "../frontend/src/contracts/downloads";
import type { DownloadProgress } from "../frontend/src/services/downloads/ports";
import { processCommand, quoteWindowsArgument } from "../frontend/src/platform/neutralino/process";
import type { ProcessRunner } from "../frontend/src/platform/neutralino/process";
import { MediaHost } from "./helpers/mediaHost";
import { createMediaProbe } from "../frontend/src/services/downloads/probe";

const enabled = process.platform === "win32" && process.env.JAVM_DOWNLOAD_INTEGRATION === "1";
describe.runIf(enabled)("real HTTP / HLS downloads and FFmpeg merge", () => {
  const root = path.resolve(
    fileURLToPath(new URL("../.tmp/download-verification", import.meta.url)),
  );
  const tools: Record<string, string> = {};
  let base = "";
  let proxyAddress = "";
  const proxyRequests: string[] = [];
  const directRequests: string[] = [];
  let ranged = false;
  let slowRequests = 0;
  let peakSlowRequests = 0;
  let engine: ToolDownloadEngine;
  let host: DownloadHost;
  const media = new MediaHost();
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      if (pathname.startsWith("/proxy-only/")) {
        directRequests.push(pathname);
        response.writeHead(403);
        response.end("direct access unavailable");
        return;
      }
      if (pathname === "/forbidden.mp4") {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      if (pathname === "/headers.mp4" && request.headers["x-fixture"] !== "allowed") {
        response.writeHead(403);
        response.end();
        return;
      }
      const file = path.basename(
        pathname === "/slow.mp4" || pathname === "/headers.mp4" ? "fixture.mp4" : pathname,
      );
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(path.join(root, file));
      } catch {
        response.writeHead(404);
        response.end();
        return;
      }
      const total = bytes.length;
      const range = /^bytes=(\d+)-$/.exec(request.headers.range || "");
      if (range) {
        ranged = true;
        const start = Number(range[1]);
        if (start >= total) {
          response.writeHead(416, { "Content-Range": `bytes */${total}` });
          response.end();
          return;
        }
        bytes = bytes.subarray(start);
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${total - 1}/${total}`);
      }
      response.setHeader("Content-Length", bytes.length);
      response.setHeader("ETag", '"fixture-v1"');
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader(
        "Content-Type",
        file.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
      );
      const slowHls = pathname.startsWith("/slow-hls/") && !file.endsWith(".m3u8");
      if (pathname === "/slow.mp4" || slowHls) {
        slowRequests++;
        peakSlowRequests = Math.max(peakSlowRequests, slowRequests);
        let offset = 0;
        const timer = setInterval(
          () => {
            const chunkSize = slowHls ? 1024 : 8192;
            response.write(bytes.subarray(offset, offset + chunkSize));
            offset += chunkSize;
            if (offset >= bytes.length) {
              clearInterval(timer);
              response.end();
            }
          },
          slowHls ? 80 : 35,
        );
        response.on("close", () => {
          clearInterval(timer);
          slowRequests--;
        });
      } else response.end(bytes);
    })().catch(() => response.destroy());
  });
  // A loopback-only forward proxy: fixtures never reach external hosts.
  const proxyServer = createServer((request, response) => {
    const target = new URL(request.url!, base);
    if (target.origin !== base && target.hostname !== "javm-download.invalid") {
      response.writeHead(403).end();
      return;
    }
    proxyRequests.push(target.pathname);
    const upstream = httpRequest(
      `${base}${target.pathname.replace(/^\/proxy-only/, "")}`,
      {
        headers: request.headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502).end();
    });
    response.on("close", () => upstream.destroy());
    upstream.end();
  });
  const run: ProcessRunner = (file, args, signal, output) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const [command, ...encodedArgs] = processCommand(file, args).split(" ");
      const child = spawn(command!, encodedArgs, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdOut = "";
      let stdErr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdOut += chunk;
        output?.(chunk, "stdout");
      });
      child.stderr.on("data", (chunk: string) => {
        stdErr += chunk;
        output?.(chunk, "stderr");
      });
      const abort = () => {
        if (child.pid) {
          try {
            execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          } catch {
            /* The child may already have exited. */
          }
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        resolve({ exitCode: code ?? -1, stdOut, stdErr });
      });
    });
  beforeAll(async () => {
    await fs.mkdir(root, { recursive: true });
    tools.ffmpeg =
      process.env.JAVM_FFMPEG ||
      execFileSync("where.exe", ["ffmpeg.exe"], { encoding: "utf8", windowsHide: true })
        .trim()
        .split(/\r?\n/)[0]!;
    await media.start(path.join(root, `media-probe-${crypto.randomUUID()}.sqlite3`));
    tools.curl =
      process.env.JAVM_CURL ||
      execFileSync("where.exe", ["curl.exe"], { encoding: "utf8", windowsHide: true })
        .trim()
        .split(/\r?\n/)[0]!;
    tools["N_m3u8DL-RE"] =
      process.env.JAVM_DOWNLOADER || path.resolve(root, "../../bin/tools/N_m3u8DL-RE.exe");
    // Fixture encoding is a development tool; production FFmpeg only needs remuxing.
    const fixtureFfmpeg = process.env.JAVM_FIXTURE_FFMPEG || tools.ffmpeg;
    execFileSync(
      fixtureFfmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440",
        "-t",
        "12",
        "-g",
        "24",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        path.join(root, "fixture.mp4"),
      ],
      { windowsHide: true },
    );
    execFileSync(
      fixtureFfmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.join(root, "fixture.mp4"),
        "-c",
        "copy",
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        path.join(root, "segment%02d.ts"),
        path.join(root, "playlist.m3u8"),
      ],
      { windowsHide: true },
    );
    execFileSync(
      fixtureFfmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.join(root, "fixture.mp4"),
        "-an",
        "-c",
        "copy",
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        "video-init.mp4",
        "-hls_segment_filename",
        path.join(root, "video%02d.m4s"),
        path.join(root, "video.m3u8"),
      ],
      { windowsHide: true, cwd: root },
    );
    execFileSync(
      fixtureFfmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.join(root, "fixture.mp4"),
        "-vn",
        "-c",
        "copy",
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        path.join(root, "audio%02d.ts"),
        path.join(root, "audio.m3u8"),
      ],
      { windowsHide: true },
    );
    await fs.writeFile(
      path.join(root, "master.m3u8"),
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180,CODECS="avc1.64000c,mp4a.40.2",AUDIO="audio"\nvideo.m3u8\n',
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server unavailable");
    base = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyInfo = proxyServer.address();
    if (!proxyInfo || typeof proxyInfo === "string") throw new Error("proxy fixture unavailable");
    proxyAddress = `http://127.0.0.1:${proxyInfo.port}`;
    host = {
      run,
      probe: createMediaProbe(media.request.bind(media)),
      async tool(name) {
        return tools[name]!;
      },
      async defaultDirectory() {
        return root;
      },
      async open() {},
      files: {
        async mkdir(folder) {
          await fs.mkdir(folder, { recursive: true });
        },
        async stat(file) {
          try {
            const stat = await fs.stat(file);
            return { size: stat.size, isFile: stat.isFile() };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        read: (file) => fs.readFile(file, "utf8"),
        write: (file, data) => fs.writeFile(file, data, "utf8"),
        async list(folder) {
          return (await fs.readdir(folder, { withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(folder, entry.name));
        },
        move: fs.rename,
        async remove(file) {
          const resolved = path.resolve(file);
          if (!resolved.startsWith(`${root}${path.sep}`))
            throw new Error("fixture cleanup outside workspace");
          await fs.rm(file, { force: true, recursive: true });
        },
      },
    };
    engine = new ToolDownloadEngine(host);
  }, 30000);
  afterAll(async () => {
    await media.close();
    proxyServer.closeAllConnections();
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const taskFor = (suffix: string, headers: Record<string, string> = {}) =>
    createDownloadTasks(
      {
        urls: [`${base}/${suffix}`],
        name: "测试 & 下载's",
        directory: root,
        kind: "auto",
        headers,
      },
      [],
    )[0]!;
  it("keeps a successful HTTP transfer direct when a shared proxy is configured", async () => {
    const count = proxyRequests.length;
    const task = taskFor("fixture.mp4");
    await new ToolDownloadEngine(host, async () => proxyAddress).run(
      task,
      defaultDownloadSettings,
      AbortSignal.timeout(15000),
      () => {},
      async () => {},
    );
    expect(proxyRequests).toHaveLength(count);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(0);
  }, 20000);
  it.each(["fixture.mp4", "playlist.m3u8"])(
    "retries blocked %s through a real local proxy and produces a verified MP4",
    async (file) => {
      const count = proxyRequests.length;
      const directCount = directRequests.length;
      const task = taskFor(`proxy-only/${file}`);
      // N_m3u8DL-RE's custom proxy deliberately bypasses loopback hosts.
      // The reserved .invalid name fails direct DNS and is served locally by our proxy.
      if (file.endsWith("m3u8")) task.url = `http://javm-download.invalid/proxy-only/${file}`;
      const messages: string[] = [];
      try {
        await new ToolDownloadEngine(host, async () => proxyAddress).run(
          task,
          defaultDownloadSettings,
          AbortSignal.timeout(60000),
          (progress) => {
            if (progress.line) messages.push(progress.line);
          },
          async () => {},
        );
      } finally {
        await fs.writeFile(
          path.join(root, `proxy-${file}.json`),
          JSON.stringify(
            {
              task,
              messages,
              direct: directRequests.slice(directCount),
              proxied: proxyRequests.slice(count),
            },
            null,
            2,
          ),
        );
      }
      if (!file.endsWith("m3u8"))
        expect(directRequests.slice(directCount)).toContain(`/proxy-only/${file}`);
      expect(proxyRequests.slice(count)).toContain(`/proxy-only/${file}`);
      expect(messages.filter((line) => line === "直连失败，正在通过网络代理重试。")).toHaveLength(
        1,
      );
      expect((await fs.stat(task.output)).size).toBeGreaterThan(0);
      if (file.endsWith("m3u8"))
        expect(proxyRequests.slice(count).some((url) => url.endsWith(".ts"))).toBe(true);
    },
    65000,
  );
  it("passes long private arguments as JSON data without shell expansion", async () => {
    const value = "中文 & %PATH% $(whoami);'".repeat(400);
    const args = ["-e", "process.stdout.write(process.argv[1])", value];
    const payload = path.join(root, `arguments-${crypto.randomUUID()}.json`);
    await fs.writeFile(
      payload,
      JSON.stringify({
        file: process.execPath,
        arguments: args.map(quoteWindowsArgument).join(" "),
      }),
    );
    const [command, ...parameters] = processCommand(
      process.execPath,
      args,
      undefined,
      payload,
    ).split(" ");
    expect(execFileSync(command!, parameters, { encoding: "utf8", windowsHide: true })).toBe(value);
    await expect(fs.stat(payload)).rejects.toThrow();
  }, 20000);
  it("overrides child proxy variables while retaining the system environment", async () => {
    const proxy = "http://127.0.0.1:7897/中文'&";
    const args = [
      "-e",
      "console.log(JSON.stringify({root:process.env.SystemRoot,proxy:process.env.HTTP_PROXY}))",
    ];
    const payload = path.join(root, `environment-${crypto.randomUUID()}.json`);
    await fs.writeFile(
      payload,
      JSON.stringify({
        file: process.execPath,
        arguments: args.map(quoteWindowsArgument).join(" "),
        envs: { HTTP_PROXY: proxy },
      }),
    );
    const [command, ...parameters] = processCommand(
      process.execPath,
      args,
      undefined,
      payload,
    ).split(" ");
    const result = JSON.parse(
      execFileSync(command!, parameters, { encoding: "utf8", windowsHide: true }),
    );
    expect(result).toEqual({ root: process.env.SystemRoot, proxy });
    expect(result.root).toBeTruthy();
    await expect(fs.stat(payload)).rejects.toThrow();
  }, 20000);
  it("terminates the tool if its application host exits unexpectedly", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const [command, ...args] = processCommand(
      process.execPath,
      ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
      owner.pid,
    ).split(" ");
    const wrapper = spawn(command!, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const toolPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Tool startup timeout")), 10000);
        wrapper.stdout.once("data", (bytes: Buffer) => {
          clearTimeout(timeout);
          resolve(Number(bytes.toString().trim()));
        });
      });
      const closed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Tool outlived its host")), 10000);
        wrapper.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      owner.kill();
      await closed;
      expect(Number.isSafeInteger(toolPid) && toolPid > 0).toBe(true);
      expect(() => process.kill(toolPid, 0)).toThrow();
    } finally {
      owner.kill();
      if (wrapper.exitCode === null && wrapper.pid) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(wrapper.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          /* Already exited. */
        }
      }
    }
  }, 25000);
  const execute = async (
    task: DownloadTask,
    signal = AbortSignal.timeout(60000),
    onProgress?: (update: DownloadProgress) => void,
  ) => {
    await engine.run(
      task,
      { ...defaultDownloadSettings, directory: root },
      signal,
      (update) => {
        const { line: _line, ...stats } = update;
        Object.assign(task, stats);
        onProgress?.(update);
      },
      async (phase, inputs) => {
        task.phase = phase;
        if (inputs) task.inputs = inputs;
      },
    );
  };
  it("downloads an MP4 with headers and produces a playable MP4 with audio", async () => {
    const task = taskFor("headers.mp4", { "X-Fixture": "allowed" });
    await execute(task);
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true, videoTracks: 1, audioTracks: 1 });
    expect(result.durationMs).toBeGreaterThan(11000);
    expect(task.outputSize).toBe((await fs.stat(task.output)).size);
    expect(task.downloaded).toBe((await fs.stat(path.join(root, "fixture.mp4"))).size);
  }, 60000);
  it("probes standalone audio and rejects non-media through the Extension", async () => {
    const audio = await host.probe(path.join(root, "audio00.ts"), AbortSignal.timeout(20000));
    expect(audio).toMatchObject({ video: false, audio: true, videoTracks: 0, audioTracks: 1 });
    expect(audio.durationMs).toBeGreaterThan(0);
    const invalid = path.join(root, "invalid-media.mp4");
    await fs.writeFile(invalid, "This is not a media file.");
    await expect(host.probe(invalid, AbortSignal.timeout(20000))).rejects.toThrow();
  });
  it("bounds media probe requests, processes cancellation and keeps control messages responsive", async () => {
    const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
    const jobs = ids.map((id) =>
      media.request("media.probe", { id, path: path.join(root, "fixture.mp4") }),
    );
    const settled = Promise.allSettled(jobs);
    const controls = Promise.all(ids.map((id) => media.request("media.cancelProbe", { id })));
    await media.request("hello");
    await controls;
    const results = await settled;
    const failures = results
      .filter((item) => item.status === "rejected")
      .map((item) => String(item.reason));
    expect(failures.some((message) => message.includes("队列已满"))).toBe(true);
    expect(failures.some((message) => message.includes("取消"))).toBe(true);
    await expect(
      host.probe(path.join(root, "fixture.mp4"), AbortSignal.timeout(20000)),
    ).resolves.toMatchObject({ video: true, audio: true });
  }, 30000);
  it("downloads two real files in parallel while the event loop remains responsive", async () => {
    peakSlowRequests = 0;
    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats++;
    }, 10);
    const tasks = [taskFor("slow.mp4?parallel=1"), taskFor("slow.mp4?parallel=2")];
    try {
      await Promise.all(tasks.map((task) => execute(task)));
      expect(peakSlowRequests).toBeGreaterThanOrEqual(2);
      expect(heartbeats).toBeGreaterThan(10);
      for (const task of tasks) expect(task.outputSize).toBe((await fs.stat(task.output)).size);
    } finally {
      clearInterval(timer);
    }
  }, 60000);
  it("downloads HLS segments and merges audio and video", async () => {
    const task = taskFor("slow-hls/playlist.m3u8");
    const liveSizes: number[] = [];
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (
        task.phase === "download" &&
        update.totalIsEstimate &&
        update.progress! < 100 &&
        update.total! > 0
      )
        liveSizes.push(update.total!);
    });
    expect(liveSizes.length).toBeGreaterThan(0);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("merges a master HLS playlist with separate fMP4 video and audio tracks", async () => {
    const task = taskFor("slow-hls/master.m3u8");
    const liveSizes: number[] = [];
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (
        task.phase === "download" &&
        update.totalIsEstimate &&
        update.progress! < 100 &&
        update.total! > 0
      )
        liveSizes.push(update.total!);
    });
    expect(liveSizes.length).toBeGreaterThan(0);
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true, videoTracks: 1, audioTracks: 1 });
    expect(result.durationMs).toBeGreaterThan(11000);
    await expect(fs.stat(task.workDirectory)).rejects.toThrow();
    expect(task.outputSize).toBe((await fs.stat(task.output)).size);
    expect(task.totalIsEstimate).toBe(false);
  }, 60000);
  it("keeps partial MP4 bytes on pause and resumes with HTTP Range", async () => {
    const task = taskFor("slow.mp4");
    const controller = new AbortController();
    const pending = execute(task, controller.signal);
    const part = path.join(task.workDirectory, "download.part");
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if ((await fs.stat(part).catch(() => null))?.size) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect((await fs.stat(part)).size).toBeGreaterThan(0);
    await execute(task);
    expect(ranged).toBe(true);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("fails HTTP errors without publishing a completed output", async () => {
    const task = taskFor("forbidden.mp4");
    await expect(execute(task)).rejects.toThrow("下载");
    await expect(fs.stat(task.output)).rejects.toThrow();
  }, 30000);
  it("can retry a failed merge from retained inputs without contacting the source", async () => {
    const task = taskFor("forbidden.mp4");
    task.phase = "merge";
    task.inputs = [path.join(root, "fixture.mp4")];
    await execute(task);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 30000);
  it("retains downloaded input on a mux failure and succeeds with a merge-only retry", async () => {
    const task = taskFor("fixture.mp4");
    const failing = new ToolDownloadEngine({
      ...host,
      run: async (file, args, ...rest) =>
        args.includes("-progress")
          ? { exitCode: 1, stdOut: "", stdErr: "simulated mux failure" }
          : run(file, args, ...rest),
    });
    await expect(
      failing.run(
        task,
        { ...defaultDownloadSettings, directory: root },
        AbortSignal.timeout(30000),
        () => {},
        async (phase, inputs) => {
          task.phase = phase;
          if (inputs) task.inputs = inputs;
        },
      ),
    ).rejects.toThrow("合并");
    expect(task.phase).toBe("merge");
    expect((await fs.stat(task.inputs[0]!)).size).toBeGreaterThan(10000);
    task.url = `${base}/forbidden.mp4`;
    await execute(task);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
});
