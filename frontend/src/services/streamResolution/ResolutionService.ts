import type {
  ResolutionHandle,
  ResolutionOutcome,
  ResolutionRequest,
  ResolutionTask,
} from "../../contracts/streamResolution";
import type { ResolutionHttpPort, ResolutionParser, ResolutionWebviewPort } from "./ports";
import { StopUnconfirmedError } from "../downloads/ports";
import { ResolutionHttpSession } from "./http";
import { resolveHttp } from "./resolve";
import { bounds, check, failure, normalizeRequest, ResolutionError } from "./shared";
import { logEvent } from "../logging/events";

interface Job {
  request: ResolutionRequest;
  key: string;
  source: string;
  task: ResolutionTask;
  handle: ResolutionHandle;
  abort: AbortController;
  settle(outcome: ResolutionOutcome): void;
  queuedTimer?: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
}
interface Options {
  http?: ResolutionHttpPort;
  parser: ResolutionParser;
  prepare?: () => Promise<void>;
  getProxy?: () => Promise<string>;
  webview?: ResolutionWebviewPort;
}
export interface ResolutionSnapshot {
  available: boolean;
  webviewAvailable: boolean;
  tasks: ResolutionTask[];
  cleanupPending: number;
}

export class ResolutionService {
  private waiting: Job[] = [];
  private active = new Set<Job>();
  private inFlight = new Map<string, Job>();
  private cleanup = new Map<string, () => Promise<void>>();
  private history: ResolutionTask[] = [];
  private listeners = new Set<() => void>();
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private cleaning?: Promise<void>;
  private snapshot: ResolutionSnapshot;
  constructor(private readonly options: Options) {
    this.snapshot = {
      available: !!options.http,
      webviewAvailable: !!options.http && !!options.webview,
      tasks: [],
      cleanupPending: 0,
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(immediate = false) {
    if (!immediate) {
      this.timer ??= setTimeout(() => this.publish(true), 200);
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.snapshot = {
      available: !!this.options.http && !this.stopped,
      webviewAvailable: !!this.options.http && !!this.options.webview && !this.stopped,
      tasks: [
        ...this.history,
        ...[...this.active, ...this.waiting].map((job) => ({ ...job.task })),
      ],
      cleanupPending: this.cleanup.size,
    };
    for (const listener of this.listeners) listener();
  }
  submit(input: ResolutionRequest): ResolutionHandle {
    const id = crypto.randomUUID();
    try {
      if (this.stopped || !this.options.http) throw new ResolutionError("unavailable");
      if (this.cleanup.size) throw new ResolutionError("cleanup_failed");
      const request = normalizeRequest(input);
      if (request.provider === "webview" && !this.options.webview)
        throw new ResolutionError("unavailable");
      const key = JSON.stringify([
        request.provider,
        request.url,
        Object.entries(request.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        Object.entries(request.publicHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        request.failRule,
        request.preferProxy,
      ]);
      const existing = this.inFlight.get(key);
      // 相同请求共享任务；任一调用者取消即取消该共享任务。
      if (existing && !existing.abort.signal.aborted) return existing.handle;
      if (this.waiting.length >= bounds.queue) throw new ResolutionError("limit_exceeded");
      let settle!: Job["settle"];
      const result = new Promise<ResolutionOutcome>((resolve) => {
        settle = resolve;
      });
      const job: Job = {
        request,
        key,
        source: new URL(request.url).origin,
        abort: new AbortController(),
        settle,
        task: { id, provider: request.provider, state: "queued", requests: 0, found: 0 },
        handle: { id, result, cancel: () => this.cancel(job, new ResolutionError("cancelled")) },
      };
      job.queuedTimer = setTimeout(
        () => this.cancel(job, new ResolutionError("timeout")),
        request.provider === "webview" ? 300_000 : bounds.queueMs,
      );
      this.waiting.push(job);
      this.inFlight.set(key, job);
      this.drain();
      this.publish(true);
      return job.handle;
    } catch (error) {
      return { id, result: Promise.resolve(failure(error)), cancel() {} };
    }
  }
  private cancel(job: Job, reason: ResolutionError) {
    if (this.inFlight.get(job.key) !== job) return;
    job.abort.abort(reason);
    if (this.waiting.includes(job)) {
      this.waiting = this.waiting.filter((item) => item !== job);
      this.complete(job, failure(reason));
    } else {
      job.task.state = "closing";
      this.publish(true);
    }
  }
  private drain() {
    while (!this.stopped && !this.cleanup.size && this.active.size < bounds.active) {
      const index = this.waiting.findIndex(
        (job) =>
          [...this.active].filter((item) => item.source === job.source).length < bounds.perSource &&
          (job.request.provider !== "webview" ||
            [...this.active].filter((item) => item.request.provider === "webview").length <
              bounds.webviews),
      );
      if (index < 0) break;
      const job = this.waiting.splice(index, 1)[0]!;
      clearTimeout(job.queuedTimer);
      this.active.add(job);
      job.task.state = job.request.provider === "webview" ? "webview" : "http";
      job.done = this.run(job);
    }
  }
  private async run(job: Job) {
    const workMs = bounds.httpMs + (job.request.provider === "webview" ? bounds.webviewMs : 0);
    const deadline = Date.now() + workMs;
    const timer = setTimeout(() => this.cancel(job, new ResolutionError("timeout")), workMs);
    let outcome: ResolutionOutcome;
    try {
      await this.options.prepare?.();
      check(job.abort.signal);
      const proxy = (await this.options.getProxy?.()) ?? "";
      check(job.abort.signal);
      const session = (request: ResolutionRequest) => {
        const previous = job.task.requests;
        return new ResolutionHttpSession(
          request,
          this.options.http!,
          proxy,
          deadline,
          job.abort.signal,
          (requests) => {
            job.task.requests = previous + requests;
            if (job.task.requests > bounds.requests) throw new ResolutionError("limit_exceeded");
            this.publish();
          },
        );
      };
      const progress = (state: "http" | "validating", found: number) => {
        if (!job.abort.signal.aborted) {
          job.task.state = state;
          job.task.found = found;
          this.publish();
        }
      };
      let streams;
      if (job.request.provider === "webview") {
        const candidates = await this.options.webview!(job.request, job.abort.signal, proxy);
        check(job.abort.signal);
        let last: unknown = new ResolutionError("not_found");
        for (const candidate of candidates.slice(0, 3)) {
          const request = normalizeRequest({
            url: candidate.url,
            provider: "direct-hls",
            publicHeaders: candidate.publicHeaders,
            preferProxy: !!proxy,
          });
          try {
            streams = (
              await resolveHttp(
                request,
                session(request),
                this.options.parser,
                job.abort.signal,
                progress,
              )
            ).map((stream) => ({
              ...stream,
              discoveredBy: "webview" as const,
              pageUrl: job.request.url,
            }));
            // 影片页常带预告或广告短片；不足正片时长的点播不能作为资源返回。
            if (
              !streams.some((stream) =>
                stream.tracks.some((track) => track.duration >= bounds.featureSeconds),
              )
            ) {
              streams = undefined;
              throw new ResolutionError("not_found");
            }
            break;
          } catch (error) {
            if (
              !(error instanceof ResolutionError) ||
              !["not_found", "parse_failed", "unsupported_stream"].includes(error.code)
            )
              throw error;
            last = error;
          }
        }
        if (!streams) throw last;
      } else
        streams = await resolveHttp(
          job.request,
          session(job.request),
          this.options.parser,
          job.abort.signal,
          progress,
        );
      check(job.abort.signal);
      outcome = { ok: true, streams };
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        this.cleanup.set(job.task.id, error.retry);
        outcome = failure(new ResolutionError("cleanup_failed"));
      } else outcome = failure(job.abort.signal.aborted ? job.abort.signal.reason : error);
    } finally {
      clearTimeout(timer);
    }
    this.active.delete(job);
    this.complete(job, outcome);
    this.drain();
  }
  private complete(job: Job, outcome: ResolutionOutcome) {
    clearTimeout(job.queuedTimer);
    if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
    job.task.state = outcome.ok
      ? "succeeded"
      : outcome.code === "cancelled"
        ? "cancelled"
        : "failed";
    job.task.error = outcome.ok ? undefined : outcome;
    if (
      !outcome.ok &&
      ![
        "not_found",
        "invalid_input",
        "interaction_required",
        "session_required",
        "cancelled",
      ].includes(outcome.code)
    )
      logEvent(
        "error",
        "resolution",
        "failed",
        outcome.message,
        { taskId: job.task.id, errorCode: outcome.code, requests: job.task.requests },
        { action: "resolve_stream", source: job.request.provider, pageUrl: job.request.url },
      );
    this.history = [...this.history.slice(-49), { ...job.task }];
    job.settle(outcome);
    this.publish(true);
  }
  retryCleanup = (): Promise<void> => {
    if (this.cleaning) return this.cleaning;
    this.cleaning = (async () => {
      for (const [id, retry] of this.cleanup) {
        try {
          await retry();
          this.cleanup.delete(id);
        } catch {
          throw new ResolutionError("cleanup_failed");
        } finally {
          this.publish(true);
        }
      }
    })().finally(() => {
      this.cleaning = undefined;
      this.drain();
    });
    return this.cleaning;
  };
  async shutdown() {
    this.stopped = true;
    for (const job of [...this.waiting, ...this.active])
      this.cancel(job, new ResolutionError("cancelled"));
    this.options.parser.close();
    await Promise.all([...this.active].map((job) => job.done!));
    await this.retryCleanup();
    this.publish(true);
  }
}
