import { app, events, filesystem, init } from "@neutralinojs/lib";
import { ResolutionService } from "../../../frontend/src/services/streamResolution/ResolutionService";
import { ResolutionWorkerPool } from "../../../frontend/src/services/streamResolution/workerClient";
import { createResolutionHttp } from "../../../frontend/src/platform/neutralino/resolutionHttp";
import {
  HiddenWebviewError,
  withHiddenWebview,
} from "../../../frontend/src/platform/neutralino/hiddenWebview";
import { shutdownHttp } from "../../../frontend/src/platform/neutralino/http";
import { captureStreams } from "../../../frontend/src/services/streamResolution/capture";
import { bounds } from "../../../frontend/src/services/streamResolution/shared";
import {
  resourceSources,
  sourceRequest,
  unverifiedResourceSources,
} from "../../../frontend/src/services/streamResolution/sources";

// 全程在隐藏宿主中运行；报告只记录主机名、状态码、分辨率与时长，不记录网页标题、正文或图片。
// 与应用一致：各来源同时提交，由 ResolutionService 按隐藏实例上限并行执行。
init();
await new Promise<void>((resolve) => {
  void events.on("ready", () => resolve());
});
const root = new URLSearchParams(location.search).get("root")!;
const config = JSON.parse(await filesystem.readFile(`${root}/sweep.json`)) as {
  code: string;
  sources: string[];
  proxy: string;
};
const host = (raw: string) => {
  try {
    return new URL(raw).host;
  } catch {
    return "";
  }
};
interface Trace {
  documents: string[];
  candidates: string[];
  stage?: string;
  startedMs?: number;
}
const traces = new Map<string, Trace>();
const started = Date.now();
const resolution = new ResolutionService({
  http: createResolutionHttp(),
  parser: new ResolutionWorkerPool(),
  webview: (request, signal, proxy) => {
    const trace = traces.get(request.url)!;
    trace.startedMs = Date.now() - started;
    return withHiddenWebview(
      signal,
      proxy,
      (cdp, bounded) =>
        captureStreams(
          {
            send: cdp.send.bind(cdp),
            on: (listener) =>
              cdp.on((event) => {
                const params = event.params as Record<string, unknown>;
                const response = params.response as { url: string; status: number } | undefined;
                if (
                  event.method === "Network.responseReceived" &&
                  params.type === "Document" &&
                  response &&
                  trace.documents.length < 8
                )
                  trace.documents.push(`${host(response.url)}:${response.status}`);
                listener(event);
              }),
          },
          request,
          bounded,
        ).then((value) => {
          trace.candidates = [...new Set(value.map((item) => host(item.url)))];
          return value;
        }),
      (stage) => {
        trace.stage = stage;
      },
    ).catch((error: unknown) => {
      if (error instanceof HiddenWebviewError) trace.stage = `${error.stage}:${error.code}`;
      throw error;
    });
  },
  getProxy: async () => config.proxy,
});
const results: Record<string, unknown>[] = [];
try {
  const selected = [...resourceSources, ...unverifiedResourceSources].filter(
    (item) => !config.sources.length || config.sources.includes(item.id),
  );
  await Promise.all(
    selected.map(async (source) => {
      const request = sourceRequest(source, config.code);
      const trace: Trace = { documents: [], candidates: [] };
      traces.set(request.url, trace);
      const outcome = await resolution.submit(request).result;
      results.push({
        source: source.id,
        ok: outcome.ok,
        code: outcome.ok ? undefined : outcome.code,
        finishedMs: Date.now() - started,
        streams: outcome.ok
          ? outcome.streams.map((stream) => ({
              host: host(stream.manifestUrl),
              heights: stream.tracks.map((track) => track.height ?? 0),
              durationS: Math.round(stream.tracks[0]?.duration ?? 0),
            }))
          : [],
        trace,
      });
      await filesystem.writeFile(`${root}/progress.json`, JSON.stringify(results));
    }),
  );
  results.push({ totalMs: Date.now() - started, webviews: bounds.webviews });
} catch (error) {
  results.push({ fatal: error instanceof Error ? error.message : String(error) });
} finally {
  try {
    await resolution.shutdown();
    await shutdownHttp();
  } catch (error) {
    results.push({ cleanupError: error instanceof Error ? error.message : String(error) });
  }
  await filesystem.writeFile(`${root}/result.json`, JSON.stringify(results, null, 2));
  await app.exit();
}
