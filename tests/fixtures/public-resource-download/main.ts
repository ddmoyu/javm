import { app, events, filesystem, init } from "@neutralinojs/lib";
import { ResolutionService } from "../../../frontend/src/services/streamResolution/ResolutionService";
import { ResolutionWorkerPool } from "../../../frontend/src/services/streamResolution/workerClient";
import { createResolutionHttp } from "../../../frontend/src/platform/neutralino/resolutionHttp";
import { createHiddenWebview } from "../../../frontend/src/platform/neutralino/hiddenWebview";
import { shutdownHttp } from "../../../frontend/src/platform/neutralino/http";
import { nativeDownloadHost } from "../../../frontend/src/platform/neutralino/downloadHost";
import { ToolDownloadEngine } from "../../../frontend/src/services/downloads/ToolDownloadEngine";
import { createDownloadTasks } from "../../../frontend/src/services/downloads/input";
import { defaultDownloadSettings } from "../../../frontend/src/contracts/downloads";

// 固定公开非露骨样本；不接受来源、番号、数据库路径或下载 URL 输入。
const manifest = "https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8";
const page = `https://hlsjs.video-dev.org/demo/?src=${encodeURIComponent(manifest)}`;
init();
await new Promise<void>((resolve) => {
  void events.on("ready", () => resolve());
});
const params = new URLSearchParams(location.search);
const root = params.get("root")!;
const config = JSON.parse(await filesystem.readFile(`${root}/verification.json`)) as {
  tools: string;
  proxy: string;
};
const started = Date.now();
const report: Record<string, unknown> = { ok: false, page, startedAt: new Date().toISOString() };
let state: Record<string, unknown> = { phase: "capturing" };
let writing = false;
const progress = setInterval(() => {
  if (writing) return;
  writing = true;
  void filesystem
    .writeFile(
      `${root}/progress.json`,
      JSON.stringify({ elapsedMs: Date.now() - started, ...state }),
    )
    .catch(() => {})
    .finally(() => {
      writing = false;
    });
}, 2000);
const resolution = new ResolutionService({
  http: async (request, signal) => {
    const value = await createResolutionHttp()(request, signal);
    const rows = (report.requests ??= []) as unknown[];
    rows.push({
      url: request.url,
      status: value.status,
      bytes: value.body.byteLength,
      headers: value.headers,
    });
    return value;
  },
  parser: new ResolutionWorkerPool(),
  webview: async (...args) => {
    const value = await createHiddenWebview()(...args);
    report.candidates = value;
    return value;
  },
  getProxy: async () => config.proxy,
});
const unsubscribe = resolution.subscribe(() => {
  state = { phase: "resolving", tasks: resolution.getSnapshot().tasks };
});
try {
  const result = await resolution.submit({ url: page, provider: "webview" }).result;
  report.resolution = result;
  if (!result.ok) throw new Error(result.message);
  const stream = result.streams.find((value) => value.manifestUrl === manifest);
  if (!stream) throw new Error("没有捕获到本次指定的公开视频清单。");
  report.captureMs = Date.now() - started;
  unsubscribe();
  const download = createDownloadTasks(
    {
      urls: [stream.manifestUrl],
      directory: `${root}/downloads`,
      name: "Public-Angel-One",
      kind: "hls",
      headers: { ...stream.context.publicHeaders },
    },
    [],
  )[0]!;
  const settings = {
    ...defaultDownloadSettings,
    ffmpegPath: `${config.tools}/ffmpeg.exe`,
    hlsPath: `${config.tools}/N_m3u8DL-RE.exe`,
    curlPath: `${config.tools}/curl.exe`,
  };
  await filesystem.createDirectory(download.directory);
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  state = { phase: "download" };
  await new ToolDownloadEngine(nativeDownloadHost, async () => config.proxy).run(
    download,
    settings,
    signal,
    (update) => {
      const { line: _line, ...stats } = update;
      Object.assign(download, stats);
      state = { ...state, ...stats };
    },
    async (phase, inputs) => {
      download.phase = phase;
      if (inputs) download.inputs = inputs;
      state = { phase };
    },
  );
  const probe = await nativeDownloadHost.probe(download.output, signal);
  const stat = await filesystem.getStats(download.output);
  if (!probe.video || !probe.audio || probe.durationMs < 10000 || stat.size < 100000)
    throw new Error("下载文件未通过真实音视频轨检查。");
  Object.assign(report, { ok: true, output: download.output, bytes: stat.size, probe });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  clearInterval(progress);
  unsubscribe();
  try {
    await resolution.shutdown();
    await shutdownHttp();
  } catch (error) {
    report.ok = false;
    report.cleanupError = error instanceof Error ? error.message : String(error);
  }
  report.elapsedMs = Date.now() - started;
  await filesystem.writeFile(`${root}/result.json`, JSON.stringify(report, null, 2));
  await app.exit();
}
