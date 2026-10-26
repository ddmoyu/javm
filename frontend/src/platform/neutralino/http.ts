import { events, extensions, filesystem, os } from "@neutralinojs/lib";
import { HttpService } from "../../services/network/HttpService";
import type { HttpRequest, HttpResponse } from "../../services/network/HttpService";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { logEvent } from "../../services/logging/events";
import { browserHeaders } from "../../services/network/browserHeaders";
import { waitForUpdateStartup } from "./updateGate";

class HttpRpc {
  private listening?: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listener = (
    event: CustomEvent<{ requestId: string; ok: boolean; result: unknown; error?: string }>,
  ) => {
    const reply = event.detail;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error || "常驻网络模块请求失败。"));
  };
  ready() {
    return (this.listening ??= events
      .on("javm.database.response", this.listener)
      .then(() => {})
      .catch((error: unknown) => {
        this.listening = undefined;
        throw error;
      }));
  }
  request<T>(method: string, params: unknown, timeout: number): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("常驻网络模块未响应。"));
      }, timeout);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      void extensions
        .dispatch("net.ddmoyu.javm.database", "javm.database.request", {
          requestId,
          protocol: 1,
          method,
          params,
        })
        .catch((error: unknown) => {
          if (this.pending.delete(requestId)) {
            clearTimeout(timer);
            reject(error);
          }
        });
    });
  }
  async close() {
    if (this.listening) {
      await this.listening;
      await events.off("javm.database.response", this.listener);
    }
  }
}
const rpc = new HttpRpc();
let directory: Promise<string> | undefined;
const pendingStops = new Set<() => Promise<void>>();
const stopPendingMessage = "仍有网络请求尚未确认停止，请重试清理；仍失败时请退出应用后重试。";
let recovering: Promise<void> | undefined;
function retryPendingStops(): Promise<void> {
  if (recovering) return recovering;
  if (!pendingStops.size) return Promise.resolve();
  // 共用一次有界恢复，不能让两个搜索来源或其他业务同时重复取消同一传输。
  recovering = Promise.allSettled([...pendingStops].map((retry) => retry()))
    .then((results) => {
      if (pendingStops.size || results.some((result) => result.status === "rejected"))
        throw new StopUnconfirmedError(retryPendingStops, stopPendingMessage);
    })
    .finally(() => {
      recovering = undefined;
    });
  return recovering;
}
async function root() {
  return (directory ??= (async () => {
    const path = `${await os.getPath("temp")}/javm-http-${crypto.randomUUID()}`;
    await filesystem.createDirectory(path);
    return path;
  })().catch((error) => {
    directory = undefined;
    throw error;
  }));
}
async function remove(path: string) {
  try {
    await filesystem.remove(path);
  } catch (error) {
    if ((error as { code?: string }).code !== "NE_FS_NOPATHE") throw error;
  }
}
const service = new HttpService({
  async execute(request, signal) {
    const deadline = Date.now() + request.timeoutMs;
    await waitForUpdateStartup();
    signal.throwIfAborted();
    await rpc.ready();
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const path = `${await root()}/${id}.part`;
    await retryPendingStops();
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("网络请求等待恢复超时。");
    let cancellation: Promise<unknown> | undefined;
    const stop = async () => {
      const result = await rpc.request<{ stopped: boolean }>("http.cancel", { id }, 5000);
      if (result.stopped !== true) throw new Error("网络请求停止未确认。");
    };
    const cancel = () => {
      cancellation ??= stop();
      void cancellation.catch(() => {});
    };
    const { output: _output, cacheTtlMs: _cache, purpose, ...options } = request;
    logEvent("debug", "network", "http_started", "常驻 HTTP 请求已开始", {
      purpose,
      id,
      proxyEnabled: !!request.proxy,
    });
    const running = rpc.request<HttpResponse>(
      "http.request",
      {
        ...options,
        id,
        output: path,
        timeoutMs: remaining,
        connectTimeoutMs: Math.min(request.connectTimeoutMs ?? 5000, remaining),
      },
      remaining + 6000,
    );
    signal.addEventListener("abort", cancel, { once: true });
    let deferred = false;
    try {
      const response = await running;
      if (cancellation) await cancellation;
      signal.throwIfAborted();
      logEvent(
        response.exitCode || response.status >= 400 ? "warn" : "debug",
        "network",
        "http_completed",
        "常驻 HTTP 请求已结束",
        {
          purpose,
          id,
          status: response.status,
          exitCode: response.exitCode,
          bytes: response.bytes,
          connections: response.connections,
          elapsedMs: response.elapsedMs,
          timeoutMs: request.timeoutMs,
        },
        { action: request.method ?? "GET", requestUrl: request.url },
      );
      return { ...response, path };
    } catch (error) {
      logEvent(
        "warn",
        "network",
        "http_failed",
        "常驻 HTTP 请求失败，正在确认停止",
        {
          purpose,
          id,
          proxyEnabled: !!request.proxy,
          error: error instanceof Error ? error.message : "未知错误",
        },
        { action: request.method ?? "GET", requestUrl: request.url },
      );
      try {
        await (cancellation ?? stop());
      } catch (stopError) {
        deferred = true;
        let retrying: Promise<void> | undefined;
        let recovered = false;
        const retry = (): Promise<void> => {
          if (recovered) return Promise.resolve();
          return (retrying ??= (async () => {
            await stop();
            await remove(path);
            pendingStops.delete(retry);
            recovered = true;
            logEvent("info", "network", "http_recovered", "网络请求已确认停止并完成清理", {
              purpose,
              id,
            });
          })().finally(() => {
            retrying = undefined;
          }));
        };
        pendingStops.add(retry);
        logEvent(
          "warn",
          "network",
          "http_stop_unconfirmed",
          stopPendingMessage,
          { purpose, id, error: stopError instanceof Error ? stopError.message : "未知错误" },
          { action: request.method ?? "GET", requestUrl: request.url },
        );
        throw new StopUnconfirmedError(retry, stopPendingMessage);
      }
      await remove(path);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!deferred && signal.aborted) await remove(path);
    }
  },
  copy: (from, to) => filesystem.copy(from, to, { overwrite: true, recursive: false, skip: false }),
  remove,
});
export const requestHttp = (request: HttpRequest, signal: AbortSignal) =>
  service.request({ ...request, headers: browserHeaders(request, navigator) }, signal);
export async function shutdownHttp() {
  await service.shutdown();
  await retryPendingStops();
  if (directory) await remove(await directory);
  await rpc.close();
}
