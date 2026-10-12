import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultNetworkSettings } from "../frontend/src/contracts/network";
import { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import type { ProxyProbe } from "../frontend/src/services/network/NetworkSettingsService";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { testProxyConnection } from "../frontend/src/platform/neutralino/proxyTest";
import { requestHttp } from "../frontend/src/platform/neutralino/http";

vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: vi.fn(),
}));

const proxy = "http://127.0.0.1:7890";
function fixture(probe: ProxyProbe = async () => ({ elapsedMs: 123 }), available = true) {
  const store = { read: vi.fn(async () => null), write: vi.fn(async () => {}) };
  return { service: new NetworkSettingsService(store, available, probe), store };
}

afterEach(() => vi.clearAllMocks());

describe("代理连通性测试服务", () => {
  it("测试当前未保存地址，成功反馈耗时且不修改代理配置", async () => {
    const probe = vi.fn<ProxyProbe>(async () => ({ elapsedMs: 123 }));
    const { service, store } = fixture(probe);
    await service.testProxy(proxy);
    expect(probe).toHaveBeenCalledWith(proxy, expect.any(AbortSignal));
    expect(service.getSnapshot()).toMatchObject({
      settings: defaultNetworkSettings,
      testing: false,
      testResult: { proxy, status: "success", message: expect.stringContaining("123 ms") },
    });
    expect(store.write).not.toHaveBeenCalled();
    service.clearTestResult();
    expect(service.getSnapshot().testResult).toBeNull();
  });
  it("失败后允许重试，不遗留成功状态", async () => {
    const probe = vi.fn<ProxyProbe>();
    probe.mockResolvedValueOnce({ elapsedMs: 10 }).mockRejectedValueOnce(new Error("代理认证失败"));
    const { service } = fixture(probe);
    await service.testProxy(proxy);
    await service.testProxy(proxy);
    expect(service.getSnapshot()).toMatchObject({
      testing: false,
      testResult: { status: "failed", message: "代理认证失败" },
    });
  });
  it("不并发或排队测试，取消后即使底层返回成功也不误报", async () => {
    let finish!: (result: { elapsedMs: number }) => void;
    const probe = vi.fn<ProxyProbe>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { service } = fixture(probe);
    const pending = service.testProxy(proxy);
    await Promise.resolve();
    await expect(service.testProxy(proxy)).rejects.toThrow("正在测试代理");
    service.cancelTest();
    expect(probe.mock.calls[0]![1].aborted).toBe(true);
    expect(service.getSnapshot().testing).toBe(true);
    finish({ elapsedMs: 10 });
    await pending;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot()).toMatchObject({
      testing: false,
      testResult: { status: "cancelled" },
    });
  });
  it("退出取消测试并等待进程收尾，不再接受新测试", async () => {
    let finish!: (result: { elapsedMs: number }) => void;
    const probe = vi.fn<ProxyProbe>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { service } = fixture(probe);
    const pending = service.testProxy(proxy);
    await Promise.resolve();
    let stopped = false;
    const shutdown = service.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(probe.mock.calls[0]![1].aborted).toBe(true);
    finish({ elapsedMs: 1 });
    await Promise.all([pending, shutdown]);
    expect(stopped).toBe(true);
    expect(service.getSnapshot().testResult?.status).toBe("cancelled");
    await expect(service.testProxy(proxy)).rejects.toThrow("应用正在退出");
  });
  it("未确认进程退出时阻止新测试，退出应用时重试清理", async () => {
    const retry = vi.fn(async () => {});
    const { service } = fixture(async () => {
      throw new StopUnconfirmedError(retry);
    });
    await service.testProxy(proxy);
    expect(service.getSnapshot().testResult?.status).toBe("failed");
    await expect(service.testProxy(proxy)).rejects.toThrow("未能确认");
    await service.shutdown();
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("启动前取消不会发起请求", async () => {
    const probe = vi.fn<ProxyProbe>();
    const { service } = fixture(probe);
    const pending = service.testProxy(proxy);
    service.cancelTest();
    await pending;
    expect(probe).not.toHaveBeenCalled();
    expect(service.getSnapshot().testResult?.status).toBe("cancelled");
  });
  it("浏览器和无效地址不能产生虚假成功", async () => {
    const probe = vi.fn<ProxyProbe>();
    await expect(fixture(probe, false).service.testProxy(proxy)).rejects.toThrow("桌面端");
    await expect(fixture(probe).service.testProxy("not-a-proxy")).rejects.toThrow("有效");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("常驻 HTTP 代理连通性适配", () => {
  beforeEach(() => {
    vi.mocked(requestHttp).mockResolvedValue({
      exitCode: 0,
      status: 204,
      tunnelStatus: 200,
      elapsedMs: 125,
      bytes: 0,
      headers: {},
      setCookie: false,
      ambiguousHeaders: false,
      effectiveUrl: "",
      connections: 1,
    });
  });
  it.each([proxy, "https://localhost:7890", "socks5://localhost:1080", "socks5h://localhost:1080"])(
    "显式使用 %s，禁止代理绕过、重定向与不安全 TLS",
    async (address) => {
      const signal = new AbortController().signal;
      expect(await testProxyConnection(address, signal)).toEqual({ elapsedMs: 125 });
      const [request, actualSignal] = vi.mocked(requestHttp).mock.calls[0]!;
      expect(actualSignal).toBe(signal);
      expect(request).toMatchObject({ proxy: address, timeoutMs: 15000, maxBytes: 1024 });
      expect(request.maxRedirects).toBeUndefined();
    },
  );
  it.each([
    [7, "000\n000\n0.001", "无法连接代理"],
    [28, "000\n000\n15.000", "超时"],
    [60, "000\n200\n0.010", "证书验证失败"],
    [56, "000\n407\n0.010", "认证失败"],
    [0, "200\n200\n0.010", "HTTP 200"],
    [0, "302\n200\n0.010", "HTTP 302"],
    [0, "204\n200\nnot-a-number", "HTTP 204"],
    [97, "000\n000\n0.010", "SOCKS5"],
  ])("拒绝错误响应 %s / %s，不泄露代理凭据", async (exitCode, stdOut, message) => {
    const [status, tunnelStatus, seconds] = stdOut.split("\n").map(Number);
    vi.mocked(requestHttp).mockResolvedValue({
      exitCode,
      status: status!,
      tunnelStatus: tunnelStatus!,
      elapsedMs: seconds! * 1000,
      bytes: 0,
      headers: {},
      setCookie: false,
      ambiguousHeaders: false,
      effectiveUrl: "",
      connections: 1,
    });
    await expect(testProxyConnection(proxy, new AbortController().signal)).rejects.toThrow(message);
    expect(requestHttp).toHaveBeenCalledTimes(1);
  });
  it("常驻模块不可用时不回退到外部程序", async () => {
    vi.mocked(requestHttp).mockRejectedValueOnce(new Error("常驻网络模块未响应。"));
    await expect(testProxyConnection(proxy, new AbortController().signal)).rejects.toThrow(
      "常驻网络模块未响应",
    );
    expect(requestHttp).toHaveBeenCalledOnce();
  });
});
