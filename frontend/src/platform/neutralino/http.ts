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
    await waitForUpdateStartup();
    if (pendingStops.size) throw new Error("仍有网络请求尚未确认停止，请退出应用后重试。");
    await rpc.ready();
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const path = `${await root()}/${id}.part`;
    signal.throwIfAborted();
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
    logEvent("debug", "network", "http_started", "常驻 HTTP 请求已开始", { purpose, id });
    const running = rpc.request<HttpResponse>(
      "http.request",
      { ...options, id, output: path },
      request.timeoutMs + 6000,
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
        },
      );
      return { ...response, path };
    } catch (error) {
      try {
        await (cancellation ?? stop());
      } catch {
        deferred = true;
        const retry = async () => {
          await stop();
          await remove(path);
          pendingStops.delete(retry);
        };
        pendingStops.add(retry);
        throw new StopUnconfirmedError(retry);
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
  for (const retry of pendingStops) await retry();
  if (directory) await remove(await directory);
  await rpc.close();
}
