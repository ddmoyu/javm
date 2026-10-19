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
