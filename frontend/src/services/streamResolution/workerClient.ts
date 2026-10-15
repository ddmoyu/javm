import type { ParseTasks, ResolutionParser } from "./ports";
import type { ResolutionFailure } from "../../contracts/streamResolution";
import { bounds, check, ResolutionError } from "./shared";

interface Work {
  start(): void;
  cancel(): void;
}
/** 两个隔离 Worker；超时或取消直接终止所属 Worker，迟到消息不能结算。 */
export class ResolutionWorkerPool implements ResolutionParser {
  private active = new Set<Work>();
  private waiting: Work[] = [];
  private closed = false;
  constructor(
    private readonly create = () =>
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  ) {}

  run<K extends keyof ParseTasks>(
    operation: K,
    input: ParseTasks[K]["input"],
    signal: AbortSignal,
  ): Promise<ParseTasks[K]["output"]> {
    if (this.closed) return Promise.reject(new ResolutionError("cancelled"));
    if (this.waiting.length >= bounds.queue)
      return Promise.reject(new ResolutionError("limit_exceeded"));
    return new Promise((resolve, reject) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false,
        ready = false;
      const finish = (value?: ParseTasks[K]["output"], error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
        }
        this.active.delete(work);
        this.waiting = this.waiting.filter((item) => item !== work);
        if (error) reject(error);
        else resolve(value!);
        this.drain();
      };
      const abort = () =>
        finish(
          undefined,
          signal.reason instanceof ResolutionError
            ? signal.reason
            : new ResolutionError("cancelled"),
        );
      const work: Work = {
        cancel: abort,
        start: () => {
          try {
            check(signal);
            worker = this.create();
            timer = setTimeout(() => finish(undefined, new ResolutionError("timeout")), 3000);
            worker.onmessage = (
              event: MessageEvent<{
                ready?: boolean;
                value?: ParseTasks[K]["output"];
                error?: { code: ResolutionFailure; fallbackEligible: boolean };
              }>,
            ) => {
              if (settled) return;
              if (event.data.ready && !ready) {
                ready = true;
                clearTimeout(timer);
                timer = setTimeout(
                  () => finish(undefined, new ResolutionError("limit_exceeded")),
                  250,
                );
                try {
                  worker!.postMessage({ operation, input }, [input.body]);
                } catch {
                  finish(undefined, new ResolutionError("parse_failed", true));
                }
              } else if (ready && !event.data.ready) {
                const error = event.data.error;
                finish(
                  event.data.value,
                  error ? new ResolutionError(error.code, error.fallbackEligible) : undefined,
                );
              }
            };
            worker.onerror = worker.onmessageerror = () =>
              finish(undefined, new ResolutionError("parse_failed", true));
          } catch (error) {
            finish(undefined, error);
          }
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(work);
      if (signal.aborted) abort();
      else this.drain();
    });
  }
  private drain() {
    while (!this.closed && this.active.size < 2 && this.waiting.length) {
      const work = this.waiting.shift()!;
      this.active.add(work);
      work.start();
    }
  }
  close() {
    this.closed = true;
    for (const work of [...this.waiting, ...this.active]) work.cancel();
  }
}
