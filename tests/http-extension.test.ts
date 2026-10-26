import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HttpRequest, HttpResponse } from "../frontend/src/services/network/HttpService";

interface Envelope {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}
const native = vi.hoisted(() => ({
  listener: undefined as ((event: unknown) => void) | undefined,
  handle: (_data: Envelope) => {},
  files: new Map<string, string>(),
  dispatch: vi.fn(),
  remove: vi.fn(),
  copy: vi.fn(),
  off: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  events: {
    on: async (_event: string, listener: (event: unknown) => void) => {
      native.listener = listener;
    },
    off: native.off,
  },
  extensions: { dispatch: native.dispatch },
  os: { getPath: async () => "C:/safe-mock" },
  filesystem: { createDirectory: async () => {}, remove: native.remove, copy: native.copy },
}));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: native.log }));
const request: HttpRequest = {
  url: "https://safe.invalid/mock",
  output: "mock-output",
  maxBytes: 100,
  timeoutMs: 5000,
  purpose: "catalog",
};
function reply(data: Envelope, result: unknown) {
  native.listener?.({ detail: { requestId: data.requestId, ok: true, result } });
}
function response(patch: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    exitCode: 0,
    bytes: 4,
    headers: {},
    setCookie: false,
    ambiguousHeaders: false,
    effectiveUrl: request.url,
    connections: 1,
    elapsedMs: 1,
    tunnelStatus: 0,
    ...patch,
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.files.clear();
  native.dispatch.mockImplementation(async (_id, _event, data: Envelope) => native.handle(data));
  native.remove.mockImplementation(async (file: string) => {
    native.files.delete(file);
  });
  native.copy.mockImplementation(
    async (from: string, to: string, options?: { overwrite: boolean }) => {
      if (!native.files.has(from)) throw new Error("Mock 文件尚未写入");
      if (native.files.has(to) && !options?.overwrite) throw new Error("Mock 输出文件已存在");
      native.files.set(to, native.files.get(from)!);
    },
  );
});
afterEach(() => {
  native.listener = undefined;
  vi.useRealTimers();
});

describe("Issue12 公共 HTTP 恢复", () => {
  async function blockedHttp() {
    let running: Envelope | undefined;
    native.handle = (data) => {
      if (data.method === "http.request") {
        running = data;
        native.files.set(String(data.params.output), "safe partial");
      } else {
        reply(running!, response({ exitCode: 42 }));
        reply(data, { stopped: false });
      }
    };
    const http = await import("../frontend/src/platform/neutralino/http");
    const abort = new AbortController();
    const done = http.requestHttp(request, abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(running).toBeDefined());
    abort.abort();
    const error = await done;
    expect(error).toMatchObject({ name: "StopUnconfirmedError" });
    return { ...http, running: running!, error: error as { retry(): Promise<void> } };
  }
  function succeed(data: Envelope) {
    if (data.method === "http.cancel") reply(data, { stopped: true });
    else {
      native.files.set(String(data.params.output), "safe recovered");
      reply(data, response());
    }
  }
  const next = (name: string): HttpRequest => ({
    ...request,
    url: `https://${name}.invalid/mock`,
    output: `safe-${name}`,
    purpose: "resolution",
  });

  it("原请求和取消 RPC 均超时后，下一次业务请求可确认停止并恢复", async () => {
    vi.useFakeTimers();
    let running: Envelope | undefined;
    native.handle = (data) => {
      if (data.method === "http.request") {
        running = data;
        native.files.set(String(data.params.output), "safe partial");
      }
    };
    const { requestHttp, shutdownHttp } = await import("../frontend/src/platform/neutralino/http");
    const done = requestHttp({ ...request, timeoutMs: 1000 }, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(running).toBeDefined());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await done).toMatchObject({ name: "StopUnconfirmedError" });
    expect(native.files.has(String(running!.params.output))).toBe(true);
    native.handle = succeed;
    await expect(requestHttp(next("magnet"), new AbortController().signal)).resolves.toMatchObject({
      status: 200,
    });
    expect(native.files.has(String(running!.params.output))).toBe(false);
    expect(native.log.mock.calls.some((call) => call[2] === "http_stop_unconfirmed")).toBe(true);
    expect(native.log.mock.calls.some((call) => call[2] === "http_recovered")).toBe(true);
    await shutdownHttp();
  });

  it("两个来源与旧调用方并发恢复共用停止确认，确认前不发送新请求", async () => {
    const http = await blockedHttp();
    const cancellations: Envelope[] = [];
    native.handle = (data) => {
      if (data.method === "http.cancel") cancellations.push(data);
      else succeed(data);
    };
    const a = http.requestHttp(next("first"), new AbortController().signal);
    const b = http.requestHttp(next("second"), new AbortController().signal);
    const cleanup = http.error.retry();
    await vi.waitFor(() => expect(cancellations).toHaveLength(1));
    expect(
      native.dispatch.mock.calls.filter((call) => call[2].method === "http.request"),
    ).toHaveLength(1);
    expect(native.files.has(String(http.running.params.output))).toBe(true);
    reply(cancellations[0]!, { stopped: true });
    await Promise.all([a, b, cleanup]);
    expect(cancellations).toHaveLength(1);
    expect(native.files.has(String(http.running.params.output))).toBe(false);
    await http.error.retry();
    expect(cancellations).toHaveLength(1);
    await http.shutdownHttp();
  });

  it("恢复失败仍保留文件与可重试错误，后续重试成功才解除阻塞", async () => {
    const http = await blockedHttp();
    const blocked = (await http
      .requestHttp(next("failed"), new AbortController().signal)
      .catch((error: unknown) => error)) as {
      name: string;
      message: string;
      retry(): Promise<void>;
    };
    expect(blocked.name).toBe("StopUnconfirmedError");
    expect(blocked.message).toContain("网络请求尚未确认停止");
    expect(blocked.message).not.toContain("下载进程");
    expect(native.files.has(String(http.running.params.output))).toBe(true);
    expect(
      native.dispatch.mock.calls.filter((call) => call[2].method === "http.request"),
    ).toHaveLength(1);
    native.handle = succeed;
    await blocked.retry();
    await http.requestHttp(next("recovered"), new AbortController().signal);
    await http.shutdownHttp();
  });

  it("恢复期间取消不会再发起搜索请求", async () => {
    const http = await blockedHttp();
    let cancellation: Envelope | undefined;
    native.handle = (data) => {
      cancellation = data;
    };
    const abort = new AbortController();
    const done = http.requestHttp(next("cancelled"), abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(cancellation).toBeDefined());
    abort.abort();
    reply(cancellation!, { stopped: true });
    expect(await done).toMatchObject({ name: "AbortError" });
    expect(
      native.dispatch.mock.calls.filter((call) => call[2].method === "http.request"),
    ).toHaveLength(1);
    await http.shutdownHttp();
  });

  it("恢复耗时耗尽请求预算时不再发起原生请求", async () => {
    vi.useFakeTimers();
    const http = await blockedHttp();
    let cancellation: Envelope | undefined;
    native.handle = (data) => {
      cancellation = data;
    };
    const done = http
      .requestHttp({ ...next("expired"), timeoutMs: 100 }, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(cancellation).toBeDefined());
    await vi.advanceTimersByTimeAsync(150);
    reply(cancellation!, { stopped: true });
    expect(await done).toMatchObject({ message: "网络请求等待恢复超时。" });
    expect(
      native.dispatch.mock.calls.filter((call) => call[2].method === "http.request"),
    ).toHaveLength(1);
    await http.shutdownHttp();
  });
});
describe("常驻 HTTP 官方 Extension 适配（安全 mock）", () => {
  it("备用封面来源能够覆盖上次失败留下的输出文件", async () => {
    native.files.set("mock-output", "Safe mock error document");
    native.handle = (data) => {
      native.files.set(String(data.params.output), "Safe mock replacement");
      reply(data, response());
    };
    const { requestHttp, shutdownHttp } = await import("../frontend/src/platform/neutralino/http");
    await requestHttp(request, new AbortController().signal);
    expect(native.files.get("mock-output")).toBe("Safe mock replacement");
    await shutdownHttp();
  });
  it("文件写完才复制输出，正文、代理凭据和请求头不进入日志", async () => {
    native.handle = (data) => {
      native.files.set(String(data.params.output), "safe");
      reply(data, response());
    };
    const { requestHttp, shutdownHttp } = await import("../frontend/src/platform/neutralino/http");
    expect(
      await requestHttp(
        {
          ...request,
          headers: { Authorization: "Bearer safe-secret" },
          proxy: "http://user:safe-password@127.0.0.1:1",
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 200, connections: 1 });
    expect(native.files.get("mock-output")).toBe("safe");
    expect(native.dispatch).toHaveBeenCalledExactlyOnceWith(
      "net.ddmoyu.javm.database",
      "javm.database.request",
      expect.objectContaining({ method: "http.request", protocol: 1 }),
    );
    expect(JSON.stringify(native.log.mock.calls)).not.toMatch(/safe-secret|safe-password|Bearer/);
    expect(JSON.stringify(native.log.mock.calls)).toContain(request.url);
    await shutdownHttp();
    expect(native.off).toHaveBeenCalledOnce();
  });
  it("取消收到原生确认后才删除临时文件，关闭时取消事件监听", async () => {
    let running: Envelope | undefined;
    const abort = new AbortController();
    native.handle = (data) => {
      if (data.method === "http.request") {
        running = data;
        native.files.set(String(data.params.output), "part");
      } else {
        reply(running!, response({ exitCode: 42 }));
        reply(data, { stopped: true });
      }
    };
    const { requestHttp, shutdownHttp } = await import("../frontend/src/platform/neutralino/http");
    const done = requestHttp(request, abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(running).toBeDefined());
    abort.abort();
    expect(await done).toMatchObject({ name: "AbortError" });
    expect(native.files.has(String(running!.params.output))).toBe(false);
    expect(native.copy).not.toHaveBeenCalled();
    await shutdownHttp();
    expect(native.off).toHaveBeenCalledOnce();
  });
  it("缺少停止确认时保留文件和重试句柄，退出重试确认后才清理", async () => {
    let running: Envelope | undefined;
    let confirmed = false;
    native.handle = (data) => {
      if (data.method === "http.request") {
        running = data;
        native.files.set(String(data.params.output), "part");
      } else {
        reply(running!, response({ exitCode: 42 }));
        reply(data, { stopped: confirmed });
      }
    };
    const { requestHttp, shutdownHttp } = await import("../frontend/src/platform/neutralino/http");
    const abort = new AbortController();
    const done = requestHttp(request, abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(running).toBeDefined());
    abort.abort();
    expect(await done).toMatchObject({ name: "StopUnconfirmedError" });
    expect(native.files.has(String(running!.params.output))).toBe(true);
    await expect(requestHttp(request, new AbortController().signal)).rejects.toThrow(
      "尚未确认停止",
    );
    confirmed = true;
    await shutdownHttp();
    expect(native.files.has(String(running!.params.output))).toBe(false);
    expect(native.off).toHaveBeenCalledOnce();
  });
});
