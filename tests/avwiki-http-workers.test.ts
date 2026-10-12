import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import type { AvwikiBrowserDiagnostics } from "../frontend/src/services/catalog/avwikiBrowser";
import type { CdpEvent } from "../frontend/src/services/streamResolution/cdp";
import { createCatalogHttp } from "../frontend/src/platform/neutralino/catalogHttp";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";

// 页面地址只用于正式校验；全部 HTTP、文件、CDP 操作均由安全 mock 响应。
const native = vi.hoisted(() => ({ http: vi.fn(), remove: vi.fn(async () => {}), log: vi.fn() }));
vi.mock("../frontend/src/platform/neutralino/http", () => ({ requestHttp: native.http }));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: native.log }));
vi.mock("@neutralinojs/lib", () => ({
  os: { getPath: async () => "C:/safe-mock" },
  filesystem: {
    createDirectory: async () => {},
    remove: native.remove,
    getStats: async () => ({ isFile: true, size: 24 }),
    readFile: async () => "<main>Safe fixture</main>",
  },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const url = "https://avwikidb.com/actor/1/";
class Browser {
  listeners = new Set<(event: CdpEvent) => void>();
  onNavigate = () => {};
  onResume = (_id?: string) => {};
  emit(method: string, params: Record<string, unknown>, sessionId = "root") {
    for (const listener of this.listeners) listener({ method, params, sessionId });
  }
  document(status: number, challenge: boolean) {
    this.emit("Network.requestWillBeSent", {
      type: "Document",
      requestId: "main",
      frameId: "frame",
    });
    this.emit("Network.responseReceived", {
      type: "Document",
      requestId: "main",
      frameId: "frame",
      response: { url, status, headers: challenge ? { "cf-mitigated": "challenge" } : {} },
    });
  }
  on = (listener: (event: CdpEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  send = vi.fn(
    async (
      method: string,
      params: Record<string, unknown> = {},
      id?: string,
    ): Promise<Record<string, unknown>> => {
      if (method === "Target.getTargets")
        return { targetInfos: [{ type: "page", targetId: "blank" }] };
      if (method === "Target.attachToTarget") return { sessionId: "root" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      if (method === "Page.navigate") this.onNavigate();
      if (method === "Runtime.runIfWaitingForDebugger") this.onResume(id);
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: String(params.expression).startsWith("globalThis.")
              ? "<main>Safe fixture</main>"
              : { href: url, length: 25, bytes: 25 },
          },
        };
      return {};
    },
  );
}
describe("常驻 HTTP 与 403 子目标修复（安全 mock）", () => {
  it("共享 Worker 先配置网络拦截再恢复运行，合成验证可继续到作品读取", async () => {
    const browser = new Browser();
    const diagnostics = vi.fn();
    browser.onNavigate = () => {
      browser.document(403, true);
      browser.emit("Target.attachedToTarget", {
        sessionId: "shared",
        targetInfo: { type: "shared_worker", targetId: "worker" },
      });
    };
    browser.onResume = (id) => {
      if (id === "shared") browser.document(200, false);
    };
    await expect(
      readAvwikiBrowserPage(
        browser,
        url,
        new AbortController().signal,
        undefined,
        undefined,
        diagnostics,
      ),
    ).resolves.toBe("<main>Safe fixture</main>");
    const calls = browser.send.mock.calls;
    expect(
      calls.findIndex(
        ([method, _params, id]) => method === "Network.setBlockedURLs" && id === "shared",
      ),
    ).toBeLessThan(
      calls.findIndex(
        ([method, _params, id]) => method === "Runtime.runIfWaitingForDebugger" && id === "shared",
      ),
    );
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ workers: 1, resumedWorkers: 1 }),
    );
    expect(browser.listeners.size).toBe(0);
  });
  it.each(["net::ERR_PROXY_CONNECTION_FAILED", "https://sensitive.invalid/?token=secret"])(
    "验证子请求失败只记录计数与标准码：%s",
    async (errorText) => {
      const browser = new Browser(),
        abort = new AbortController();
      let diagnostic: AvwikiBrowserDiagnostics | undefined;
      browser.onNavigate = () => {
        browser.document(403, true);
        for (const type of ["Image", "Script"]) {
          browser.emit("Network.requestWillBeSent", { type, requestId: type });
          browser.emit("Network.loadingFailed", { requestId: type, errorText });
        }
        abort.abort(new Error("Safe mock timeout"));
      };
      await expect(
        readAvwikiBrowserPage(browser, url, abort.signal, undefined, undefined, (value) => {
          diagnostic = value;
        }),
      ).rejects.toThrow("Safe mock timeout");
      expect(diagnostic).toMatchObject({
        failedResources: 1,
        lastResourceType: "Script",
        lastNetworkError: errorText.startsWith("net::")
          ? "ERR_PROXY_CONNECTION_FAILED"
          : "NETWORK_FAILED",
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/secret|https:|sensitive/);
      expect(browser.listeners.size).toBe(0);
    },
  );
  it("常驻模块返回 403 时仅兜底一次；同一来源和代理传给隐藏读取", async () => {
    vi.stubGlobal("navigator", { userAgent: "Safe mock browser" });
    native.http.mockResolvedValue({ status: 403, exitCode: 0 });
    const network = {
      getProxy: async () => "http://127.0.0.1:1",
    } as unknown as NetworkSettingsService;
    const browser = vi.fn(async () => "<main>Safe fixture</main>");
    const signal = new AbortController().signal;
    expect(await createCatalogHttp(network, async () => {}, browser)(url, signal)).toContain(
      "Safe fixture",
    );
    expect(native.http).toHaveBeenCalledOnce();
    expect(native.http).toHaveBeenCalledWith(
      expect.objectContaining({ url, purpose: "catalog", maxBytes: 2 * 1024 * 1024 }),
      signal,
    );
    expect(browser).toHaveBeenCalledExactlyOnceWith(url, signal, "http://127.0.0.1:1");
  });
});
