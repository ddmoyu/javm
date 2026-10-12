import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import type { AvwikiBrowserDiagnostics } from "../frontend/src/services/catalog/avwikiBrowser";
import type { CdpEvent } from "../frontend/src/services/streamResolution/cdp";
import { fetchCatalogWithWebview } from "../frontend/src/platform/neutralino/catalogWebview";
import { HiddenWebviewError } from "../frontend/src/platform/neutralino/hiddenWebview";
import { cleanLog } from "../frontend/src/services/logging/events";

const native = vi.hoisted(() => ({ browser: vi.fn(), log: vi.fn() }));
vi.mock("../frontend/src/platform/neutralino/hiddenWebview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../frontend/src/platform/neutralino/hiddenWebview")>()),
  withHiddenWebview: native.browser,
}));
vi.mock("../frontend/src/services/logging/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../frontend/src/services/logging/events")>()),
  logEvent: native.log,
}));
afterEach(() => vi.resetAllMocks());

// 地址仅供正式校验器使用，所有操作由内存 CDP mock 响应。
const url = "https://avwikidb.com/actor/1/";
const content = "<main>Safe cancellation fixture</main>";
class Browser {
  listeners = new Set<(event: CdpEvent) => void>();
  onNavigate: () => Record<string, unknown> = () => ({});
  world: Record<string, unknown> = {
    TextEncoder,
    location: { href: url },
    document: {
      readyState: "complete",
      querySelector: (selector: string) => (selector === "main" ? { outerHTML: content } : null),
    },
  };
  emit(method: string, params: Record<string, unknown>, sessionId = "root") {
    for (const listener of this.listeners) listener({ method, params, sessionId });
  }
  request(id: string, type = "Fetch", resourceUrl = `${url}safe-check`) {
    this.emit("Network.requestWillBeSent", {
      requestId: id,
      type,
      frameId: "frame",
      request: { url: resourceUrl },
    });
  }
  document(id: string, challenge = false) {
    this.request(id, "Document", url);
    this.emit("Network.responseReceived", {
      requestId: id,
      type: "Document",
      frameId: "frame",
      loaderId: id,
      response: {
        url,
        status: challenge ? 403 : 200,
        headers: challenge ? { "cf-mitigated": "challenge" } : {},
      },
    });
    this.emit("Page.frameNavigated", { frame: { id: "frame", loaderId: id } });
  }
  cancel(id: string, extra: Record<string, unknown> = {}) {
    this.emit("Network.loadingFailed", { requestId: id, errorText: "net::ERR_ABORTED", ...extra });
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
      if (method === "Page.navigate") return this.onNavigate();
      if (method === "Runtime.evaluate")
        return { result: { value: runInNewContext(String(params.expression), this.world) } };
      return {};
    },
  );
}

async function read(browser: Browser, signal = new AbortController().signal) {
  let diagnostic: AvwikiBrowserDiagnostics | undefined;
  let value: string | undefined;
  let error: unknown;
  try {
    value = await readAvwikiBrowserPage(browser, url, signal, undefined, undefined, (result) => {
      diagnostic = result;
    });
  } catch (reason) {
    error = reason;
  }
  expect(browser.listeners.size).toBe(0);
  return { value, error, diagnostic };
}

describe("隐藏验证取消事件（安全 mock）", () => {
  it("超时开始回收进程后，不把请求取消和脚本销毁写成验证失败原因", async () => {
    const browser = new Browser(),
      abort = new AbortController();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      browser.request("pending");
      abort.abort(new HiddenWebviewError("timeout", "read"));
      browser.cancel("pending", { canceled: true });
      browser.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Safe teardown" } });
      return {};
    };
    const result = await read(browser, abort.signal);
    expect(result.error).toMatchObject({ code: "timeout" });
    expect(result.diagnostic).toMatchObject({
      requests: 2,
      failedResources: 0,
      canceledResources: 0,
      scriptErrors: 0,
      lastNetworkError: "",
    });
    expect(browser.world.__javmCatalogPage).toBeUndefined();
  });

  it.each([{ errorText: "net::ERR_ABORTED" }, { errorText: "net::ERR_FAILED", canceled: true }])(
    "超时前的请求主动取消单独计数，允许验证继续成功：%j",
    async (failure) => {
      const browser = new Browser();
      browser.onNavigate = () => {
        browser.document("challenge", true);
        browser.request(
          "canceled",
          "Fetch",
          "https://challenges.cloudflare.com/safe-check?token=private",
        );
        browser.cancel("canceled", failure);
        browser.document("ready");
        return {};
      };
      const result = await read(browser);
      expect(result.value).toBe(content);
      expect(result.diagnostic).toMatchObject({
        failedResources: 0,
        canceledResources: 1,
        lastCanceledType: "Fetch",
        lastCanceledSource: "challenge",
        lastNetworkError: "",
      });
      expect(JSON.stringify(result.diagnostic)).not.toMatch(/https:|private|safe-check/);
    },
  );

  it("真正的连接错误不会被后续取消或媒体拦截覆盖", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      browser.request(
        "failed",
        "Script",
        `${new URL(url).origin}/cdn-cgi/safe-check?token=private`,
      );
      browser.emit("Network.loadingFailed", {
        requestId: "failed",
        errorText: "net::ERR_PROXY_CONNECTION_FAILED",
      });
      browser.request("blocked", "Fetch", `${url}safe.png`);
      browser.emit("Network.loadingFailed", {
        requestId: "blocked",
        errorText: "net::ERR_BLOCKED_BY_CLIENT",
        blockedReason: "inspector",
      });
      browser.request("canceled");
      browser.cancel("canceled");
      browser.document("ready");
      return {};
    };
    const result = await read(browser);
    expect(result.value).toBe(content);
    expect(result.diagnostic).toMatchObject({
      failedResources: 1,
      canceledResources: 1,
      blockedResources: 1,
      lastResourceType: "Script",
      lastNetworkError: "ERR_PROXY_CONNECTION_FAILED",
      lastFailureSource: "challenge",
    });
  });

  it("同一请求的 HTTP 错误和传输失败只计一次，取消不能覆盖 HTTP 错误", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      browser.request("subrequest");
      browser.emit("Network.responseReceived", {
        requestId: "subrequest",
        type: "Fetch",
        response: { status: 503 },
      });
      browser.emit("Network.loadingFailed", {
        requestId: "subrequest",
        errorText: "net::ERR_CONNECTION_RESET",
      });
      browser.request("denied");
      browser.emit("Network.responseReceived", {
        requestId: "denied",
        type: "Fetch",
        response: { status: 403 },
      });
      browser.cancel("denied");
      browser.document("ready");
      return {};
    };
    const result = await read(browser);
    expect(result.value).toBe(content);
    expect(result.diagnostic).toMatchObject({
      failedResources: 2,
      canceledResources: 1,
      lastNetworkError: "HTTP_403",
    });
  });

  it.each([false, true])(
    "自动重载取消旧导航时等待替代文档：Page.navigate 也返回取消=%s",
    async (navigationCanceled) => {
      const browser = new Browser();
      browser.onNavigate = () => {
        browser.request("replaced", "Document", url);
        browser.cancel("replaced", { canceled: true });
        browser.document("ready");
        return navigationCanceled ? { errorText: "net::ERR_ABORTED" } : {};
      };
      const result = await read(browser);
      expect(result.value).toBe(content);
      expect(result.error).toBeUndefined();
      expect(result.diagnostic).toMatchObject({ failedResources: 0, canceledResources: 1 });
    },
  );

  it("导航取消后没有替代文档仍按原定时限退出，不返回旧页面", async () => {
    const browser = new Browser(),
      abort = new AbortController();
    browser.onNavigate = () => {
      browser.document("replaced", true);
      browser.cancel("replaced", { canceled: true });
      setTimeout(() => abort.abort(new HiddenWebviewError("timeout", "read")), 20);
      return { errorText: "net::ERR_ABORTED" };
    };
    const result = await read(browser, abort.signal);
    expect(result.error).toMatchObject({ code: "timeout" });
    expect(result.value).toBeUndefined();
    expect(browser.world.__javmCatalogPage).toBeUndefined();
  });

  it("旧文档的迟到取消不会清空已完成的新文档", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.request("replaced", "Document", url);
      browser.document("ready");
      browser.cancel("replaced", { canceled: true });
      return { errorText: "net::ERR_ABORTED" };
    };
    expect((await read(browser)).value).toBe(content);
  });

  it("子会话相同请求编号的 HTTP 错误不能被当成主文档而忽略", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("same-id");
      browser.emit("Target.attachedToTarget", {
        sessionId: "child",
        targetInfo: { type: "iframe", targetId: "child-target" },
      });
      browser.emit(
        "Network.requestWillBeSent",
        {
          requestId: "same-id",
          type: "Fetch",
          request: { url: "https://challenges.cloudflare.com/safe-check" },
        },
        "child",
      );
      browser.emit(
        "Network.responseReceived",
        { requestId: "same-id", type: "Fetch", response: { status: 403 } },
        "child",
      );
      return {};
    };
    const result = await read(browser);
    expect(result.value).toBe(content);
    expect(result.diagnostic).toMatchObject({
      failedResources: 1,
      lastNetworkError: "HTTP_403",
      lastFailureSource: "challenge",
    });
  });

  it("当前主文档发生真实连接错误仍立即失败", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.request("failed", "Document", url);
      browser.emit("Network.loadingFailed", {
        requestId: "failed",
        errorText: "net::ERR_CONNECTION_RESET",
      });
      return {};
    };
    expect((await read(browser)).error).toMatchObject({
      message: expect.stringContaining("ERR_CONNECTION_RESET"),
    });
  });

  it("持续验证只发生取消时，提示超时且日志保留取消统计而不泄露地址", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      browser.request("canceled");
      browser.cancel("canceled");
      return {};
    };
    native.browser.mockImplementation(async (_signal, _proxy, operation) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new HiddenWebviewError("timeout", "read")), 20);
      try {
        return await operation(browser, abort.signal);
      } finally {
        clearTimeout(timer);
      }
    });
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      "自动验证未能在时限内完成（HTTP 403）",
    );
    const logs = native.log.mock.calls.map(([level, module, event, message, context]) =>
      cleanLog({ level, module, event, message, context }),
    );
    expect(logs.find(({ event }) => event === "browser_resources")?.context).toMatchObject({
      failedResources: 0,
      lastNetworkError: "",
    });
    expect(logs.find(({ event }) => event === "browser_cancellations")?.context).toMatchObject({
      canceledResources: 1,
      lastCanceledType: "Fetch",
      lastCanceledSource: "source",
    });
    expect(logs.find(({ event }) => event === "browser_failed")?.context).toMatchObject({
      code: "timeout",
      canceledResources: 1,
      failedResources: 0,
    });
    expect(JSON.stringify(logs)).not.toMatch(/https:|safe-check|token/);
  });
});

describe("PAT 与拦截诊断（安全 mock）", () => {
  const patPath = "/cdn-cgi/challenge-platform/h/b/pat/safe-private-probe";
  const response = (browser: Browser, requestUrl: string, status = 401, id = "probe") => {
    browser.request(id, "Fetch", requestUrl);
    browser.emit("Network.responseReceived", {
      requestId: id,
      type: "Fetch",
      response: { url: requestUrl, status },
    });
  };

  it.each([new URL(url).origin, "https://challenges.cloudflare.com"])(
    "只将已知来源 PAT 路径的 401 记录为预期探测：%s",
    async (origin) => {
      const browser = new Browser();
      browser.onNavigate = () => {
        browser.document("challenge", true);
        response(browser, `${origin}${patPath}?token=private`);
        browser.emit("Network.loadingFailed", {
          requestId: "probe",
          errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE",
        });
        browser.document("ready");
        return {};
      };
      const result = await read(browser);
      expect(result.value).toBe(content);
      expect(result.diagnostic).toMatchObject({
        pat401Responses: 1,
        failedResources: 0,
        lastNetworkError: "",
      });
      expect(JSON.stringify(result.diagnostic)).not.toMatch(/https:|private|cdn-cgi|token/);
    },
  );

  it.each([
    `${new URL(url).origin}/api/safe`,
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow/safe",
    `https://challenges.cloudflare.com/safe?next=${patPath}`,
    `https://challenges.cloudflare.com.invalid${patPath}`,
    `http://challenges.cloudflare.com${patPath}`,
  ])("普通 401 和相似路径／域名不能被忽略：%s", async (requestUrl) => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      response(browser, requestUrl);
      browser.document("ready");
      return {};
    };
    const result = await read(browser);
    expect(result.value).toBe(content);
    expect(result.diagnostic).toMatchObject({
      pat401Responses: 0,
      failedResources: 1,
      lastNetworkError: "HTTP_401",
    });
  });

  it("PAT 路径的其他错误及后续真实连接故障仍保留", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      response(browser, `https://challenges.cloudflare.com${patPath}`, 503, "server-error");
      response(browser, `https://challenges.cloudflare.com${patPath}`, 401, "connection-error");
      browser.emit("Network.loadingFailed", {
        requestId: "connection-error",
        errorText: "net::ERR_CONNECTION_RESET",
      });
      browser.document("ready");
      return {};
    };
    expect((await read(browser)).diagnostic).toMatchObject({
      pat401Responses: 1,
      failedResources: 2,
      lastNetworkError: "ERR_CONNECTION_RESET",
    });
  });

  it("拦截记录仅保留类型和来源分类，便于区分媒体与验证依赖", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      for (const [type, origin] of [
        ["Image", new URL(url).origin],
        ["Font", "https://challenges.cloudflare.com"],
      ] as const) {
        browser.request(type, type, `${origin}/safe-private-resource`);
        browser.emit("Network.loadingFailed", {
          requestId: type,
          errorText: "net::ERR_BLOCKED_BY_CLIENT",
          blockedReason: "inspector",
        });
      }
      browser.document("ready");
      return {};
    };
    const diagnostic = (await read(browser)).diagnostic;
    expect(diagnostic).toMatchObject({
      blockedResources: 2,
      blockedChallengeResources: 1,
      blockedResourceTypes: "Font,Image",
      failedResources: 0,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/https:|private|safe-private-resource/);
  });

  it("持续挑战的 PAT 401 不写成子请求异常，真实超时与日志仍保留", async () => {
    const browser = new Browser();
    browser.onNavigate = () => {
      browser.document("challenge", true);
      response(browser, `https://challenges.cloudflare.com${patPath}`);
      return {};
    };
    native.browser.mockImplementation(async (_signal, _proxy, operation) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new HiddenWebviewError("timeout", "read")), 20);
      try {
        return await operation(browser, abort.signal);
      } finally {
        clearTimeout(timer);
      }
    });
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      /^作品来源的自动验证未能在时限内完成（HTTP 403），已自动结束隐藏读取。$/,
    );
    const logs = native.log.mock.calls.map(([level, module, event, message, context]) =>
      cleanLog({ level, module, event, message, context }),
    );
    expect(logs.find(({ event }) => event === "browser_verification")?.context).toMatchObject({
      pat401Responses: 1,
      blockedChallengeResources: 0,
      blockedResourceTypes: "",
    });
    expect(JSON.stringify(logs)).not.toMatch(/https:|private|cdn-cgi|token/);
  });
});
