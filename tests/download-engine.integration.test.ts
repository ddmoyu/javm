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
  const requests: string[] = [];
  let limitedActive = 0;
  let limitedHeld = 0;
  let ranged = false;
  let slowRequests = 0;
  let peakSlowRequests = 0;
  let engine: ToolDownloadEngine;
  let host: DownloadHost;
  const media = new MediaHost();
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      requests.push(pathname);
      if (pathname.startsWith("/proxy-only/")) {
        directRequests.push(pathname);
        response.writeHead(403);
        response.end("direct access unavailable");
        return;
      }
      // 模拟限制单 IP 并发的源站：同一时间只服务一个请求，其余请求挂起、不作任何回应。
      if (pathname.startsWith("/limited/")) {
        if (limitedActive >= 1) {
          limitedHeld++;
          return;
        }
        limitedActive++;
        response.on("close", () => limitedActive--);
        const bytes = await fs.readFile(path.join(root, path.basename(pathname)));
        response.writeHead(200, {
          "Content-Length": bytes.length,
          "Content-Type": pathname.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
        });
        response.end(bytes);
        return;
      }
      if (pathname === "/empty.m3u8") {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        response.end();
        return;
      }
      if (pathname === "/blocked-page.ts") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!DOCTYPE html><title>Access denied</title>");
        return;
      }
      if (pathname.startsWith("/moved/")) {
        response.writeHead(302, { Location: pathname.slice("/moved".length) });
        response.end();
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
    // AES-128 fixture: a fixed test key, served by the loopback fixture server only.
    await fs.writeFile(path.join(root, "key.bin"), Buffer.alloc(16, 7));
    await fs.writeFile(
      path.join(root, "key.info"),
      `key.bin\n${path.join(root, "key.bin")}\n00000000000000000000000000000001\n`,
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
        "-hls_key_info_file",
        path.join(root, "key.info"),
        "-hls_segment_filename",
        path.join(root, "encrypted%02d.ts"),
        path.join(root, "encrypted.m3u8"),
      ],
      { windowsHide: true },
    );
    await fs.writeFile(
      path.join(root, "broken.m3u8"),
      "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nsegment00.ts\n#EXTINF:1,\nforbidden.mp4\n#EXT-X-ENDLIST\n",
    );
    await fs.writeFile(
      path.join(root, "live.m3u8"),
      "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nsegment00.ts\n",
    );
    // 关键帧间隔 10 秒、按时间切段：去掉首段后，播放列表开头 8 秒内没有关键帧与视频参数。
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
        "30",
        "-g",
        "240",
        "-keyint_min",
        "240",
        "-sc_threshold",
        "0",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_flags",
        "split_by_time",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        path.join(root, "gop%02d.ts"),
        path.join(root, "gop-full.m3u8"),
      ],
      { windowsHide: true },
    );
    {
      const rows = (await fs.readFile(path.join(root, "gop-full.m3u8"), "utf8")).split(/\r?\n/);
      const first = rows.findIndex((row) => row.startsWith("#EXTINF"));
      // 删除第一段（带关键帧的那段）的 EXTINF 与地址两行。
      rows.splice(first, 2);
      await fs.writeFile(path.join(root, "gop-late-keyframe.m3u8"), rows.join("\n"));
    }
    // 伪装成图片的分片：每个 TS 分片前拼接一张真实的 PNG 图片。
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
        "color=c=gray:s=16x16",
        "-frames:v",
        "1",
        path.join(root, "cover.png"),
      ],
      { windowsHide: true },
    );
    {
      const image = await fs.readFile(path.join(root, "cover.png"));
      const source = await fs.readFile(path.join(root, "playlist.m3u8"), "utf8");
      for (const segment of source.match(/segment\d+\.ts/g) ?? [])
        await fs.writeFile(
          path.join(root, segment.replace("segment", "disguised").replace(".ts", ".png")),
          Buffer.concat([image, await fs.readFile(path.join(root, segment))]),
        );
      await fs.writeFile(
        path.join(root, "disguised.m3u8"),
        source.replace(/segment(\d+)\.ts/g, "disguised$1.png"),
      );
      await fs.writeFile(
        path.join(root, "image-only.m3u8"),
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\ncover.png\n#EXT-X-ENDLIST\n",
      );
    }
    // 地址里带方括号的分片：curl 默认会把 [..] 当作通配范围。
    await fs.copyFile(path.join(root, "segment00.ts"), path.join(root, "segment[00].ts"));
    await fs.writeFile(
      path.join(root, "brackets.m3u8"),
      (await fs.readFile(path.join(root, "playlist.m3u8"), "utf8")).replace(
        "segment00.ts",
        "segment[00].ts",
      ),
    );
    await fs.writeFile(
      path.join(root, "fallback-master.m3u8"),
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000\nmissing-variant.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nplaylist.m3u8\n",
    );
    await fs.writeFile(
      path.join(root, "blocked.m3u8"),
      "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nsegment00.ts\n#EXTINF:1,\nblocked-page.ts\n#EXT-X-ENDLIST\n",
    );
    await fs.writeFile(
      path.join(root, "encrypted-inline.m3u8"),
      (await fs.readFile(path.join(root, "encrypted.m3u8"), "utf8")).replace(
        'URI="key.bin"',
        `URI="data:text/plain;base64,${Buffer.alloc(16, 7).toString("base64")}"`,
      ),
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
        writeBinary: (file, data) => fs.writeFile(file, data),
        async readBytes(file, length, position = 0) {
          const handle = await fs.open(file, "r");
          try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            return new Uint8Array(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
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
  it("downloads AES-128 HLS with curl and decrypts locally during the merge", async () => {
    const task = taskFor("encrypted.m3u8");
    await execute(task);
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true });
    expect(result.durationMs).toBeGreaterThan(11000);
  }, 60000);
  it("refuses encrypted HLS when FFmpeg lacks the crypto protocol", async () => {
    const task = taskFor("encrypted.m3u8");
    const limited = new ToolDownloadEngine({
      ...host,
      run: async (file, args, ...rest) =>
        args.includes("-protocols")
          ? { exitCode: 0, stdOut: "Input:\n  file\n  pipe\n", stdErr: "" }
          : run(file, args, ...rest),
    });
    await expect(
      limited.run(
        task,
        { ...defaultDownloadSettings, directory: root },
        AbortSignal.timeout(30000),
        () => {},
        async () => {},
      ),
    ).rejects.toThrow("AES-128");
    await expect(fs.stat(task.output)).rejects.toThrow();
  }, 30000);
  it("resumes HLS by downloading only segments missing after a pause", async () => {
    const task = taskFor("slow-hls/playlist.m3u8");
    const controller = new AbortController();
    const first = requests.length;
    const pending = execute(task, controller.signal, (update) => {
      if ((update.progress ?? 0) > 0) controller.abort();
    });
    await expect(pending).rejects.toThrow();
    const segments = (await fs.readFile(path.join(root, "playlist.m3u8"), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.endsWith(".ts")).length;
    const state = JSON.parse(
      await fs.readFile(path.join(task.workDirectory, "hls", "state.json"), "utf8"),
    ) as { completed: Record<string, number> };
    const kept = Object.keys(state.completed).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(segments);
    const resumed = requests.length;
    await execute(task);
    const fetched = requests.slice(resumed).filter((item) => item.endsWith(".ts")).length;
    expect(fetched).toBeLessThanOrEqual(segments - kept);
    expect(requests.slice(first).length).toBeGreaterThan(fetched);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 90000);
  it("retries a forbidden HLS segment, then reports it without publishing an output", async () => {
    const task = taskFor("broken.m3u8");
    const first = requests.length;
    // 403 可能是偶发的限流，会自动补下载；这里把轮次间隔缩短为 0。
    const quick = new ToolDownloadEngine(host, undefined, { hlsRetryDelays: [0] });
    await expect(
      quick.run(
        task,
        { ...defaultDownloadSettings, directory: root },
        AbortSignal.timeout(60000),
        () => {},
        async () => {},
      ),
    ).rejects.toThrow(/已自动重试 1 次，仍有 1 个 HLS 分片未能下载（HTTP 403 ×1）/);
    // 两轮下载，每轮 curl 自身对该分片最多再试 3 次。
    const attempts = requests.slice(first).filter((item) => item === "/forbidden.mp4").length;
    expect(attempts).toBeGreaterThan(2);
    expect(attempts).toBeLessThanOrEqual(8);
    await expect(fs.stat(task.output)).rejects.toThrow();
  }, 60000);
  it("rejects live HLS playlists", async () => {
    const task = taskFor("live.m3u8");
    await expect(execute(task)).rejects.toThrow("直播流");
  }, 30000);
  it("falls back to the next variant when the best one is unavailable", async () => {
    const task = taskFor("fallback-master.m3u8");
    const lines: string[] = [];
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (update.line) lines.push(update.line);
    });
    expect(lines).toContain("当前清晰度不可用，正在尝试下一个清晰度。");
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true });
  }, 60000);
  it("follows playlist redirects and resolves segments against the final address", async () => {
    const first = requests.length;
    const task = taskFor("moved/playlist.m3u8");
    await execute(task);
    expect(requests.slice(first)).toContain("/segment00.ts");
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("rejects a small HTML block page served as a segment", async () => {
    const task = taskFor("blocked.m3u8");
    await expect(execute(task)).rejects.toThrow("返回了网页");
    await expect(fs.stat(path.join(task.workDirectory, "hls", "v-seg-00001.ts"))).rejects.toThrow();
    await expect(fs.stat(task.output)).rejects.toThrow();
  }, 30000);
  it("reports an empty playlist response clearly", async () => {
    const task = taskFor("empty.m3u8");
    await expect(execute(task)).rejects.toThrow("空的 HLS 播放列表");
  }, 30000);
  it("decrypts HLS whose key is embedded as a data: URI", async () => {
    const first = requests.length;
    const task = taskFor("encrypted-inline.m3u8");
    await execute(task);
    expect(requests.slice(first)).not.toContain("/key.bin");
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true });
  }, 60000);
  it("re-downloads missing segments when a merge-phase task lost its files", async () => {
    const task = taskFor("playlist.m3u8");
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
    const hls = path.join(task.workDirectory, "hls");
    const segment = (await fs.readdir(hls)).find((name) => name.endsWith(".ts"))!;
    await fs.rm(path.join(hls, segment));
    const lines: string[] = [];
    const first = requests.length;
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (update.line) lines.push(update.line);
    });
    expect(lines).toContain("合并所需的分片不完整，正在重新下载缺失部分。");
    expect(requests.slice(first).filter((item) => item.endsWith(".ts"))).toHaveLength(1);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("re-downloads a segment that was truncated after it had been recorded", async () => {
    const task = taskFor("playlist.m3u8");
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
    const hls = path.join(task.workDirectory, "hls");
    const segment = (await fs.readdir(hls)).find((name) => name.endsWith(".ts"))!;
    // 文件仍在，但只剩一半字节：仅检查存在性会把它当成完整分片。
    const bytes = await fs.readFile(path.join(hls, segment));
    await fs.writeFile(path.join(hls, segment), bytes.subarray(0, bytes.length >> 1));
    const lines: string[] = [];
    const first = requests.length;
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (update.line) lines.push(update.line);
    });
    expect(lines).toContain("合并所需的分片不完整，正在重新下载缺失部分。");
    expect(requests.slice(first).filter((item) => item.endsWith(".ts"))).toHaveLength(1);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("merges HLS whose first segments contain no keyframe and logs diagnostics", async () => {
    const task = taskFor("gop-late-keyframe.m3u8");
    const lines: string[] = [];
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (update.line) lines.push(update.line);
    });
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, width: 320, height: 180 });
    expect(lines.some((line) => /^合并诊断：video\.m3u8 共 \d+ 个分片/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes("开头 47 "))).toBe(true);
  }, 60000);
  it("merges segments disguised as PNG images by skipping the image header", async () => {
    const task = taskFor("disguised.m3u8");
    const lines: string[] = [];
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (update.line) lines.push(update.line);
    });
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true, width: 320, height: 180 });
    expect(result.durationMs).toBeGreaterThan(11000);
    expect(lines.some((line) => line.includes("开头 89 50 4e 47"))).toBe(true);
    expect(lines.some((line) => /伪装成图片（PNG ×\d+）/.test(line))).toBe(true);
  }, 60000);
  it("explains a disguised segment that contains no video data", async () => {
    const task = taskFor("image-only.m3u8");
    await expect(execute(task)).rejects.toThrow("没有找到后面的视频数据");
  }, 30000);
  it("lowers concurrency step by step when the source only serves one connection", async () => {
    const task = taskFor("limited/playlist.m3u8");
    const lines: string[] = [];
    const limited = new ToolDownloadEngine(host, undefined, {
      hlsRetryDelays: [0, 0, 0],
      hlsStallTimeout: 3000,
    });
    await limited.run(
      task,
      { ...defaultDownloadSettings, directory: root },
      AbortSignal.timeout(120000),
      (update) => {
        if (update.line) lines.push(update.line);
      },
      async (phase, inputs) => {
        task.phase = phase;
        if (inputs) task.inputs = inputs;
      },
    );
    expect(limitedHeld).toBeGreaterThan(0);
    const lowered = lines.filter((line) => line.includes("下一轮并发降为"));
    expect(lowered.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("没有分片完成"))).toBe(true);
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true });
  }, 120000);
  it("downloads segment addresses containing brackets literally", async () => {
    const first = requests.length;
    const task = taskFor("brackets.m3u8");
    await execute(task);
    expect(requests.slice(first)).toContain("/segment[00].ts");
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("does not trust existing segments when the progress record is gone before merging", async () => {
    const task = taskFor("playlist.m3u8");
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
    const hls = path.join(task.workDirectory, "hls");
    const segments = (await fs.readdir(hls)).filter((name) => name.endsWith(".ts")).length;
    // 没有完成记录时无法区分完整分片和写了一半的分片，必须全部重新下载。
    await fs.rm(path.join(hls, "state.json"));
    const lines: string[] = [];
    const first = requests.length;
    await execute(task, AbortSignal.timeout(60000), (update) => {
      if (update.line) lines.push(update.line);
    });
    expect(lines).toContain("合并所需的分片不完整，正在重新下载缺失部分。");
    expect(requests.slice(first).filter((item) => item.endsWith(".ts"))).toHaveLength(segments);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
  it("recovers from a truncated progress record left by a forced exit", async () => {
    const task = taskFor("playlist.m3u8");
    const hls = path.join(task.workDirectory, "hls");
    await fs.mkdir(hls, { recursive: true });
    // 被强制结束时可能只写入一半的 JSON，以及不属于当前计划的旧文件记录。
    await fs.writeFile(path.join(hls, "state.json"), '{"fingerprint":"x","completed":{"v-seg');
    await fs.writeFile(path.join(hls, "v-seg-00000.ts"), "partial");
    await execute(task);
    const result = await host.probe(task.output, AbortSignal.timeout(20000));
    expect(result).toMatchObject({ video: true, audio: true });
  }, 60000);
  it("reports a missing local playlist instead of crashing during merge", async () => {
    const task = taskFor("playlist.m3u8");
    task.phase = "merge";
    task.inputs = [path.join(task.workDirectory, "hls", "video.m3u8")];
    // 缺失的本地播放列表会触发重新下载，而不是抛出文件不存在的原始错误。
    await execute(task);
    expect((await fs.stat(task.output)).size).toBeGreaterThan(10000);
  }, 60000);
});
