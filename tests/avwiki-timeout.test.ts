import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import { fetchCatalogWithWebview } from "../frontend/src/platform/neutralino/catalogWebview";
import { HiddenWebviewError } from "../frontend/src/platform/neutralino/hiddenWebview";
import type { CdpEvent } from "../frontend/src/services/streamResolution/cdp";
import { listing } from "./fixtures/discover-works/data";

const native = vi.hoisted(() => ({ browser: vi.fn(), log: vi.fn() }));
vi.mock("../frontend/src/platform/neutralino/hiddenWebview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../frontend/src/platform/neutralino/hiddenWebview")>()),
  withHiddenWebview: native.browser,
}));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: native.log }));
afterEach(() => vi.resetAllMocks());
const url = "https://avwikidb.com/actor/1/";

class BrowserMock {
  listeners = new Set<(event: CdpEvent) => void>();
  status = 200;
  challenge = false;
  main = true;
  networkError = "";
  responseRequestId = "main-document";
  world: Record<string, unknown> = {
    TextEncoder,
    location: { href: url },
    document: {
      readyState: "complete",
      querySelector: (selector: string) =>
        selector === "main" && this.main ? { outerHTML: listing() } : null,
    },
  };
  emit(method: string, params: Record<string, unknown>) {
    for (const listener of this.listeners) listener({ method, params, sessionId: "root" });
  }
  on = (listener: (event: CdpEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  send = vi.fn(
    async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      if (method === "Target.getTargets")
        return { targetInfos: [{ type: "page", targetId: "page" }] };
      if (method === "Target.attachToTarget") return { sessionId: "root" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Page.navigate") {
        this.emit("Network.requestWillBeSent", {
          type: "Document",
          frameId: "frame",
          requestId: "main-document",
        });
        if (this.networkError)
          this.emit("Network.loadingFailed", {
            requestId: "main-document",
            errorText: this.networkError,
          });
        else if (this.status) {
          // CDP 的 responseReceived.frameId 是可选字段；与主文档请求编号关联。
          this.emit("Network.responseReceived", {
            type: "Document",
            requestId: this.responseRequestId,
            loaderId: "document",
            response: {
              url,
              status: this.status,
              headers: this.challenge ? { "cf-mitigated": "challenge" } : {},
            },
          });
          this.emit("Page.frameNavigated", { frame: { id: "frame", loaderId: "document" } });
        }
      }
      if (method === "Runtime.evaluate")
        return { result: { value: runInNewContext(String(params.expression), this.world) } };
      return {};
    },
  );
}

function timedRead(browser: BrowserMock) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new HiddenWebviewError("timeout", "read")), 20);
  return readAvwikiBrowserPage(browser, url, abort.signal).finally(() => clearTimeout(timer));
}

describe("隐藏作品无响应定位（安全 mock）", () => {
  it("响应缺少 frameId 时仍按已知主请求读取正文", async () => {
    const browser = new BrowserMock();
    await expect(timedRead(browser)).resolves.toBe(listing());
    expect(browser.listeners.size).toBe(0);
  });
  it("缺少 frameId 的其他请求不能被当成主文档", async () => {
    const browser = new BrowserMock();
    browser.responseRequestId = "other-request";
    await expect(timedRead(browser)).rejects.toMatchObject({ code: "timeout" });
    expect(browser.send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
  });
  it.each([
    ["net::ERR_TUNNEL_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED"],
    ["sensitive url https://safe.invalid/?token=secret", "NETWORK_FAILED"],
  ])("连接失败立即结束，并只保留标准错误码：%s", async (errorText, code) => {
    const browser = new BrowserMock();
    browser.networkError = errorText;
    await expect(timedRead(browser)).rejects.toThrow(code);
    expect(browser.listeners.size).toBe(0);
  });
  it("带验证标记的 HTTP 200 仍等待验证，不将验证页面当成作品", async () => {
    const browser = new BrowserMock();
    browser.challenge = true;
    await expect(timedRead(browser)).rejects.toMatchObject({ code: "timeout" });
    expect(browser.world.__javmCatalogPage).toBeUndefined();
    expect(
      browser.send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" && String(params?.expression).startsWith("globalThis."),
      ),
    ).toBe(false);
  });
  it.each([
    ["launch", "启动超时"],
    ["connect", "本地控制连接超时"],
    ["read", "初始化超时"],
  ] as const)("%s 阶段超时不能被误报为网站验证失败", async (phase, message) => {
    native.browser.mockRejectedValue(new HiddenWebviewError("timeout", phase));
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      message,
    );
    expect(native.log.mock.calls.at(-1)?.at(-1)).toMatchObject({
      phase,
      stage: "initializing",
      status: 0,
    });
  });
  it.each([
    [0, false, "未能在时限内收到作品页面响应"],
    [403, true, "自动验证未能在时限内完成（HTTP 403）"],
    [200, false, "作品页面已返回"],
  ] as const)("收到状态 %s 后的超时保留具体失败阶段", async (status, challenge, message) => {
    const browser = new BrowserMock();
    browser.status = status;
    browser.challenge = challenge;
    browser.main = false;
    native.browser.mockImplementation(async (_signal, _proxy, read) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new HiddenWebviewError("timeout", "read")), 20);
      try {
        return await read(browser, abort.signal);
      } finally {
        clearTimeout(timer);
      }
    });
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      message,
    );
    expect(native.log.mock.calls.at(-1)?.at(-1)).toMatchObject({
      phase: "read",
      status,
      challenge,
    });
    expect(browser.listeners.size).toBe(0);
  });
});
