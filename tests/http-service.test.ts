import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HttpService } from "../frontend/src/services/network/HttpService";
import type {
  HttpPort,
  HttpRequest,
  HttpResponse,
} from "../frontend/src/services/network/HttpService";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

const request: HttpRequest = {
  url: "https://safe.invalid/sample",
  purpose: "portrait",
  maxBytes: 1024,
  timeoutMs: 5000,
  cacheTtlMs: 1000,
  output: "mock-output",
};
const response = (patch: Partial<HttpResponse> = {}) => ({
  status: 200,
  exitCode: 0,
  bytes: 10,
  headers: {},
  setCookie: false,
  ambiguousHeaders: false,
  effectiveUrl: request.url,
  connections: 1,
  elapsedMs: 1,
  tunnelStatus: 0,
  ...patch,
});
const limits = {
  parallel: 4,
  perHost: 2,
  intervalMs: 300,
  queued: 64,
  cacheBytes: 32,
  cacheEntries: 2,
};
const signal = () => new AbortController().signal;
function fixture(options = limits) {
  const transfers: {
    signal: AbortSignal;
    finish(patch?: Partial<HttpResponse>): void;
    fail(error: unknown): void;
  }[] = [];
  const port = {
    execute: vi.fn<HttpPort["execute"]>(
      (_request, abort) =>
        new Promise((resolve, reject) => {
          const id = transfers.length;
          transfers.push({
            signal: abort,
            finish: (patch) => resolve({ ...response(patch), path: `mock-${id}` }),
            fail: reject,
          });
        }),
    ),
    copy: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } satisfies HttpPort;
  return { port, transfers, service: new HttpService(port, options) };
}
afterEach(() => vi.useRealTimers());

describe("常驻 HTTP 调度与缓存（全内存安全 mock）", () => {
  it("缓存文件删除失败时停止新增传输，重试清理成功后恢复", async () => {
    const { service, transfers, port } = fixture({ ...limits, intervalMs: 0 });
    port.remove.mockRejectedValueOnce(new Error("Safe mock locked"));
    const first = service.request({ ...request, cacheTtlMs: 0 }, signal());
    transfers[0]!.finish();
    await first;
    await vi.waitFor(() => expect(port.remove).toHaveBeenCalledTimes(1));
    port.remove.mockRejectedValueOnce(new Error("Safe mock locked"));
    await expect(service.request(request, signal())).rejects.toThrow("缓存清理未完成");
    expect(port.execute).toHaveBeenCalledTimes(1);
    const retry = service.request(request, signal());
    await vi.waitFor(() => expect(port.execute).toHaveBeenCalledTimes(2));
    transfers[1]!.finish();
    await retry;
    await service.shutdown();
  });
  it("重复请求共享传输，一位订阅者取消不影响其他人；成功缓存不再执行传输", async () => {
    const { service, port, transfers } = fixture();
    const abort = new AbortController();
    const a = service.request(request, abort.signal).catch((error: unknown) => error);
    const b = service.request({ ...request, output: "second" }, signal());
    expect(port.execute).toHaveBeenCalledTimes(1);
    abort.abort();
    expect(await a).toBeInstanceOf(DOMException);
    expect(transfers[0]!.signal.aborted).toBe(false);
    transfers[0]!.finish();
    await b;
    await service.request(request, signal());
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(port.copy).toHaveBeenCalledWith("mock-0", "second");
    await service.shutdown();
    expect(port.remove).toHaveBeenCalledWith("mock-0");
  });
  it("最后一位订阅者取消，必须等传输确认停止；不能把停止失败伪装成已取消", async () => {
    const { service, transfers } = fixture();
    const abort = new AbortController();
    let settled = false;
    const pending = service.request(request, abort.signal).catch((error: unknown) => {
      settled = true;
      return error;
    });
    abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(transfers[0]!.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    const error = new StopUnconfirmedError(async () => {});
    transfers[0]!.fail(error);
    expect(await pending).toBe(error);
    await service.shutdown();
  });
  it("全局并发、同站并发与启动间隔同时生效，其他站点不会被排队站点堵住", async () => {
    vi.useFakeTimers();
    const { service, port, transfers } = fixture({ ...limits, parallel: 2, perHost: 1 });
    const a = service.request(request, signal());
    const b = service.request({ ...request, url: `${request.url}/next` }, signal());
    const c = service.request({ ...request, url: "https://other.invalid/one" }, signal());
    expect(port.execute).toHaveBeenCalledTimes(2);
    transfers[0]!.finish();
    await a;
    await vi.advanceTimersByTimeAsync(299);
    expect(port.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.execute).toHaveBeenCalledTimes(3);
    transfers[1]!.finish();
    transfers[2]!.finish();
    await Promise.all([b, c]);
    await service.shutdown();
  });
  it("排队有数量和时间上限；取消排队请求不会启动原生传输", async () => {
    vi.useFakeTimers();
    const { service, port, transfers } = fixture({ ...limits, parallel: 1, queued: 2 });
    const a = service.request(request, signal());
    const abort = new AbortController();
    const b = service
      .request({ ...request, url: `${request.url}/queued` }, abort.signal)
      .catch((e: unknown) => e);
    const c = service
      .request({ ...request, url: `${request.url}/expires`, timeoutMs: 50 }, signal())
      .catch((e: unknown) => e);
    await expect(
      service.request({ ...request, url: `${request.url}/overflow` }, signal()),
    ).rejects.toThrow("队列已满");
    abort.abort();
    await b;
    await vi.advanceTimersByTimeAsync(50);
    expect(await c).toMatchObject({ message: "网络请求排队超时。" });
    expect(port.execute).toHaveBeenCalledTimes(1);
    transfers[0]!.finish();
    await a;
    await service.shutdown();
  });
  it.each<Partial<HttpResponse>>([
    { status: 403 },
    { status: 200, headers: { "cf-mitigated": "challenge" } },
    { headers: { "cache-control": "private" } },
    { headers: { "cache-control": "no-store" } },
    { headers: { vary: "Accept, *" } },
    { setCookie: true },
    { exitCode: 35 },
  ])("拒绝、验证、私有或失败响应不缓存：%j", async (patch) => {
    const { service, port, transfers } = fixture({ ...limits, intervalMs: 0 });
    const first = service.request(request, signal());
    transfers[0]!.finish(patch);
    await first;
    const next = service.request(request, signal());
    expect(port.execute).toHaveBeenCalledTimes(2);
    transfers[1]!.finish();
    await next;
    await service.shutdown();
  });
  it.each(["Authorization", "Cookie", "Range"])("带 %s 的请求不共享和缓存", async (name) => {
    const { service, port, transfers } = fixture({ ...limits, intervalMs: 0 });
    const input = { ...request, headers: { [name]: "safe-value" } };
    const first = service.request(input, signal());
    transfers[0]!.finish();
    await first;
    const next = service.request(input, signal());
    expect(port.execute).toHaveBeenCalledTimes(2);
    transfers[1]!.finish();
    await next;
    await service.shutdown();
  });
  it("遵守服务端缓存有效期与容量，保留最近访问项", async () => {
    vi.useFakeTimers();
    const { service, transfers, port } = fixture({ ...limits, intervalMs: 0 });
    const a = service.request({ ...request, cacheTtlMs: 5000 }, signal());
    transfers[0]!.finish({ headers: { "cache-control": "max-age=2", age: "1" } });
    await a;
    await vi.advanceTimersByTimeAsync(1001);
    const again = service.request({ ...request, cacheTtlMs: 5000 }, signal());
    expect(port.execute).toHaveBeenCalledTimes(2);
    transfers[1]!.finish();
    await again;
    for (const n of [2, 3]) {
      const next = service.request({ ...request, url: `${request.url}/${n}` }, signal());
      transfers[n]!.finish();
      await next;
    }
    expect(port.remove).toHaveBeenCalledWith("mock-1");
    await service.shutdown();
  });
  it("429 Retry-After 延迟同站后续请求，排队时间仍计入超时", async () => {
    vi.useFakeTimers();
    const { service, transfers, port } = fixture();
    const first = service.request(request, signal());
    transfers[0]!.finish({ status: 429, headers: { "retry-after": "2" } });
    await first;
    const next = service.request(request, signal());
    await vi.advanceTimersByTimeAsync(1999);
    expect(port.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.execute).toHaveBeenCalledTimes(2);
    transfers[1]!.finish();
    await next;
    await service.shutdown();
  });
  it("退出会等待调用者复制完成再清缓存，之后拒绝新请求", async () => {
    const { service, transfers, port } = fixture();
    let copied!: () => void;
    vi.mocked(port.copy).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          copied = resolve;
        }),
    );
    const pending = service.request(request, signal());
    transfers[0]!.finish();
    await vi.waitFor(() => expect(port.copy).toHaveBeenCalledOnce());
    let closed = false;
    const close = service.shutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(port.remove).not.toHaveBeenCalled();
    copied();
    await pending;
    await close;
    expect(port.remove).toHaveBeenCalledWith("mock-0");
    await expect(service.request(request, signal())).rejects.toThrow("正在退出");
  });
});
