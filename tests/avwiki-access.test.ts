import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import type { CdpEvent } from "../frontend/src/services/streamResolution/cdp";
import { createCatalogHttp } from "../frontend/src/platform/neutralino/catalogHttp";
import { fetchCatalogWithWebview } from "../frontend/src/platform/neutralino/catalogWebview";
import { readAvwikiBrowserPage } from "../frontend/src/services/catalog/avwikiBrowser";
import { AvwikiWorksService } from "../frontend/src/services/catalog/AvwikiWorksService";
import { parseAvwikiWorks } from "../frontend/src/services/catalog/avwikiWorks";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";
import { listing } from "./fixtures/discover-works/data";

// 替换全部网络、磁盘和浏览器宿主；网址仅用于校验与 mock 路由，不发出真实请求。
const native = vi.hoisted(() => ({
  run: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  browser: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  os: { getPath: async () => "C:/safe-mock" },
  filesystem: {
    createDirectory: async () => {},
    remove: native.remove,
    getStats: async () => ({ isFile: true, size: 1024 }),
    readFile: native.read,
  },
}));
vi.mock("../frontend/src/platform/neutralino/process", () => ({
  findOnPath: async () => "mock-curl.exe",
  runNativeProcess: native.run,
}));
vi.mock("../frontend/src/platform/neutralino/hiddenWebview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../frontend/src/platform/neutralino/hiddenWebview")>()),
  withHiddenWebview: native.browser,
}));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: native.log }));
const url = "https://avwikidb.com/actor/1/";
const entity = { id: "1", name: "示例女演员甲", url };
const proxy = "http://127.0.0.1:7890";
const network = { getProxy: async () => proxy } as unknown as NetworkSettingsService;
const success = { exitCode: 0, stdOut: "200", stdErr: "" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 SafeFixture" });
  native.run.mockResolvedValue(success);
  native.read.mockResolvedValue(listing());
  native.remove.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

class BrowserMock {
  listeners = new Set<(event: CdpEvent) => void>();
  html = listing();
  status = 200;
  challenge = false;
  interactive = false;
  redirect = false;
  documentUrl = url;
  // Runtime.evaluate 使用正式表达式和安全 DOM stub，覆盖快照表达式及分块读取。
  world: Record<string, unknown> = {};
  emit(method: string, params: Record<string, unknown>, sessionId = "root") {
    for (const listener of this.listeners) listener({ method, params, sessionId });
  }
  on = (listener: (event: CdpEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  send = vi.fn(
    async (
      method: string,
      params: Record<string, unknown> = {},
      _session?: string,
    ): Promise<Record<string, unknown>> => {
      if (method === "Target.getTargets")
        return { targetInfos: [{ type: "page", targetId: "blank" }] };
      if (method === "Target.attachToTarget") return { sessionId: "root" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Page.navigate") {
        this.emit("Network.responseReceived", {
          type: "Document",
          frameId: "frame",
          response: {
            url: this.redirect ? "https://avwikidb.com/login/" : this.documentUrl,
            status: this.status,
            headers: this.challenge ? { "cf-mitigated": "challenge" } : {},
          },
        });
        this.world = {
          TextEncoder,
          location: { href: this.documentUrl },
          document: {
            readyState: "complete",
            querySelector: (selector: string) => {
              if (selector === "main") return { outerHTML: this.html };
              if (selector === "script#__NEXT_DATA__") return null;
              return this.interactive ? {} : null;
            },
          },
        };
      }
      if (method === "Runtime.evaluate")
        return { result: { value: runInNewContext(String(params.expression), this.world) } };
      return {};
    },
  );
}

describe("发现作品访问失败修复（安全 mock）", () => {
  it("普通 HTTP 成功时不创建浏览器，发送当前浏览器标识与站点请求头", async () => {
    const browser = vi.fn();
    const signal = new AbortController().signal;
    await expect(createCatalogHttp(network, async () => {}, browser)(url, signal)).resolves.toBe(
      listing(),
    );
    expect(browser).not.toHaveBeenCalled();
    const args = native.run.mock.calls[0]![1] as string[];
    expect(args).toContain("User-Agent: Mozilla/5.0 SafeFixture");
    expect(args).toContain("Referer: https://avwikidb.com/");
    expect(args).toContain("Sec-Fetch-Mode: navigate");
    expect(args[args.indexOf("--proxy") + 1]).toBe(proxy);
    expect(args).not.toContain("--insecure");
    expect(args).not.toContain("--location");
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("HTTP 403 后按同一演员、同一代理读取隐藏页面，再交给正式作品解析", async () => {
    native.run.mockResolvedValue({ ...success, stdOut: "403" });
    const browser = new BrowserMock();
    native.browser.mockImplementation(async (_signal, _proxy, read) => read(browser, _signal));
    const processor = {
      run: vi.fn(async (operation, input) =>
        operation === "workEntities"
          ? [entity]
          : parseAvwikiWorks(input.html, input.entity, input.page),
      ),
      close() {},
    } as unknown as CatalogProcessor;
    const service = new AvwikiWorksService(
      processor,
      createCatalogHttp(network, async () => {}, fetchCatalogWithWebview),
      async () => {},
    );
    try {
      service.select("actresses", entity.name);
      await vi.waitFor(() => expect(service.getSnapshot().result?.items).toHaveLength(2));
      expect(service.getSnapshot().error).toBe("");
      expect(native.browser.mock.calls[0]![1]).toBe(proxy);
      expect(native.browser).toHaveBeenCalledOnce();
      expect(browser.send).toHaveBeenCalledWith("Page.navigate", { url }, "root");
    } finally {
      await service.shutdown();
    }
    expect(browser.listeners.size).toBe(0);
  });
  it("直连 TLS 错误明确显示 curl 35，不盲目改变 TLS 或创建隐藏窗口", async () => {
    native.run.mockResolvedValue({
      exitCode: 35,
      stdOut: "000",
      stdErr: "mock secret https://private.invalid/ Cookie: mock-private",
    });
    const browser = vi.fn();
    await expect(
      createCatalogHttp(network, async () => {}, browser)(url, new AbortController().signal),
    ).rejects.toThrow("HTTPS 握手失败（curl 35）");
    expect(browser).not.toHaveBeenCalled();
    expect(JSON.stringify(native.log.mock.calls)).not.toMatch(/private|secret|Cookie/);
  });
  it.each([
    [401, "要求登录"],
    [302, "返回重定向"],
    [429, "过于频繁"],
  ])("HTTP %s 不作为 403 反复尝试", async (status, message) => {
    native.run.mockResolvedValue({ ...success, stdOut: String(status) });
    const browser = vi.fn();
    await expect(
      createCatalogHttp(network, async () => {}, browser)(url, new AbortController().signal),
    ).rejects.toThrow(String(message));
    expect(browser).not.toHaveBeenCalled();
  });
  it("后台名单更新不创建隐藏浏览器，403 与重定向明确区分", async () => {
    native.run.mockResolvedValue({ ...success, stdOut: "403" });
    const browser = vi.fn();
    await expect(
      createCatalogHttp(
        network,
        async () => {},
        browser,
      )("https://avwikidb.com/actor/", new AbortController().signal),
    ).rejects.toThrow("名单来源拒绝访问（HTTP 403）");
    expect(browser).not.toHaveBeenCalled();
  });
  it("取消后不启动兜底，未完成清理时继续保留清理所有权", async () => {
    const abort = new AbortController();
    native.run.mockImplementation(async () => {
      abort.abort();
      return { ...success, stdOut: "403" };
    });
    const browser = vi.fn();
    await expect(
      createCatalogHttp(network, async () => {}, browser)(url, abort.signal),
    ).rejects.toThrow();
    expect(browser).not.toHaveBeenCalled();
    native.run.mockResolvedValue({ ...success, stdOut: "403" });
    native.remove.mockClear();
    const cleanup = vi.fn(async () => {});
    browser.mockRejectedValue(new StopUnconfirmedError(cleanup));
    const error = await createCatalogHttp(
      network,
      async () => {},
      browser,
    )(url, new AbortController().signal).catch((error) => error);
    expect(error).toBeInstanceOf(StopUnconfirmedError);
    expect(native.remove).not.toHaveBeenCalled();
    await error.retry();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("隐藏浏览器仍返回 403 时自动失败，拒绝当作空作品", async () => {
    const browser = new BrowserMock();
    browser.status = 403;
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).rejects.toThrow(
      "隐藏浏览器也未获准读取",
    );
    expect(browser.listeners.size).toBe(0);
  });
  it("图片和媒体请求被阻止，不自动下载或打开额外窗口", async () => {
    const other = new BrowserMock();
    const original = other.send.getMockImplementation()!;
    other.send.mockImplementation(async (method, params, session) => {
      const value = await original(method, params, session);
      if (method === "Page.navigate") {
        for (const resourceType of ["Image", "Media"])
          other.emit("Fetch.requestPaused", {
            requestId: resourceType,
            resourceType,
            frameId: "frame",
            request: { url: "https://safe.invalid/placeholder" },
          });
        other.emit("Target.attachedToTarget", {
          sessionId: "popup",
          targetInfo: { type: "page", targetId: "popup" },
        });
      }
      return value;
    });
    await readAvwikiBrowserPage(other, url, new AbortController().signal);
    for (const requestId of ["Image", "Media"])
      expect(other.send).toHaveBeenCalledWith(
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        "root",
      );
    expect(other.send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "popup" }, undefined);
    expect(other.send).toHaveBeenCalledWith("Browser.setDownloadBehavior", { behavior: "deny" });
  });
  it("人工验证、身份跳转和超过上限的结果都自动结束读取", async () => {
    for (const condition of ["interactive", "redirect", "large", "unicode"]) {
      const browser = new BrowserMock();
      browser.interactive = condition === "interactive";
      browser.redirect = condition === "redirect";
      if (condition === "large") browser.html = "x".repeat(2 * 1024 * 1024 + 1);
      if (condition === "unicode") browser.html = "安全".repeat(400000);
      await expect(
        readAvwikiBrowserPage(browser, url, new AbortController().signal),
      ).rejects.toThrow();
      expect(browser.listeners.size).toBe(0);
    }
  });
  it("结果分块读取，等待验证时允许取消，宿主超时显示自动退出", async () => {
    const browser = new BrowserMock();
    browser.html = `<main>${"安全".repeat(45000)}</main>`;
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).resolves.toBe(
      browser.html,
    );
    expect(
      browser.send.mock.calls.filter(
        ([method, params]) =>
          method === "Runtime.evaluate" && String(params?.expression).startsWith("globalThis."),
      ),
    ).toHaveLength(3);
    const waiting = new BrowserMock();
    waiting.status = 403;
    waiting.challenge = true;
    const abort = new AbortController();
    const pending = readAvwikiBrowserPage(waiting, url, abort.signal);
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(waiting.send).toHaveBeenCalledWith("Page.navigate", { url }, "root"),
    );
    abort.abort();
    await assertion;
    expect(waiting.listeners.size).toBe(0);
    native.browser.mockRejectedValue(new ResolutionError("timeout"));
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, proxy)).rejects.toThrow(
      "隐藏浏览器初始化超时",
    );
  });
});

describe("自动验证跳转修复（安全 mock）", () => {
  it.each([
    [url, `${url}?__cf_chl_tk=safe-mock`],
    [url, "https://avwikidb.com/actor/1?__cf_chl_rt_tk=safe-mock"],
    [`${url}?page=2`, `${url}?__cf_chl_f_tk=safe-mock&page=2#ready`],
  ])("同一实体允许临时验证参数和末尾斜杠规范化：%s → %s", async (requested, actual) => {
    const browser = new BrowserMock();
    browser.documentUrl = actual;
    const original = browser.send.getMockImplementation()!;
    browser.send.mockImplementation(async (method, params, session) => {
      const result = await original(method, params, session);
      if (method === "Page.navigate")
        browser.emit("Fetch.requestPaused", {
          requestId: "verification-return",
          resourceType: "Document",
          frameId: "frame",
          request: { url: actual },
        });
      return result;
    });
    await expect(
      readAvwikiBrowserPage(browser, requested, new AbortController().signal),
    ).resolves.toBe(listing());
    expect(browser.send).toHaveBeenCalledWith(
      "Fetch.continueRequest",
      { requestId: "verification-return" },
      "root",
    );
    expect(browser.listeners.size).toBe(0);
  });

  it.each([
    "https://avwikidb.com/actor/2/?__cf_chl_tk=safe-mock",
    "https://safe.invalid/actor/1/?__cf_chl_tk=safe-mock",
    "https://avwikidb.com/login/?__cf_chl_tk=safe-mock",
    `${url}?page=2&__cf_chl_tk=safe-mock`,
    `${url}?redirect=safe-mock&__cf_chl_tk=safe-mock`,
  ])("临时参数不能放宽实体、站点、页码和额外查询参数：%s", async (actual) => {
    const browser = new BrowserMock();
    browser.documentUrl = actual;
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).rejects.toThrow(
      "页面不匹配",
    );
    expect(browser.listeners.size).toBe(0);
  });

  it("200 响应到达后等待新文档提交，不读取上一张验证页", async () => {
    const browser = new BrowserMock();
    const original = browser.send.getMockImplementation()!;
    let committed = false;
    browser.send.mockImplementation(async (method, params, session) => {
      if (method === "Runtime.evaluate") expect(committed).toBe(true);
      const result = await original(method, params, session);
      if (method === "Page.navigate") {
        browser.emit("Network.responseReceived", {
          type: "Document",
          frameId: "frame",
          loaderId: "new-page",
          response: { url, status: 200 },
        });
        setTimeout(() => {
          committed = true;
          browser.emit("Page.frameNavigated", { frame: { id: "frame", loaderId: "new-page" } });
        }, 20);
      }
      return result;
    });
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).resolves.toBe(
      listing(),
    );
  });

  it("自动重载销毁执行环境时重新读取，丢弃已读取的旧文档分块", async () => {
    const browser = new BrowserMock();
    browser.html = `<main>${"安全".repeat(45000)}</main>`;
    const original = browser.send.getMockImplementation()!;
    let reloaded = false;
    browser.send.mockImplementation(async (method, params, session) => {
      if (
        !reloaded &&
        method === "Runtime.evaluate" &&
        String(params?.expression).startsWith("globalThis.__javmCatalogPage.slice(32768,")
      ) {
        reloaded = true;
        browser.html = listing();
        browser.emit("Runtime.executionContextsCleared", {});
        browser.emit("Network.requestWillBeSent", { type: "Document", frameId: "frame" });
        browser.emit("Network.responseReceived", {
          type: "Document",
          frameId: "frame",
          loaderId: "reloaded-page",
          response: { url, status: 200 },
        });
        browser.emit("Page.frameNavigated", {
          frame: { id: "frame", loaderId: "reloaded-page" },
        });
        throw new Error("safe mock: execution context destroyed");
      }
      return original(method, params, session);
    });
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).resolves.toBe(
      listing(),
    );
    expect(reloaded).toBe(true);
    expect(browser.listeners.size).toBe(0);
  });

  it("响应诊断只返回状态码和验证标记，不暴露 URL 或响应头", async () => {
    const browser = new BrowserMock();
    browser.documentUrl = `${url}?__cf_chl_tk=safe-private-token`;
    const report = vi.fn();
    await readAvwikiBrowserPage(browser, url, new AbortController().signal, report);
    expect(report.mock.calls).toEqual([[{ status: 200, challenge: false }]]);
  });

  it("创建执行环境期间发生重载，不保存旧环境编号", async () => {
    const browser = new BrowserMock();
    const original = browser.send.getMockImplementation()!;
    let worlds = 0;
    browser.send.mockImplementation(async (method, params, session) => {
      if (method === "Page.createIsolatedWorld") {
        if (++worlds === 1) {
          browser.emit("Runtime.executionContextsCleared", {});
          return { executionContextId: 7 };
        }
        return { executionContextId: 8 };
      }
      if (method === "Runtime.evaluate") expect(params?.contextId).toBe(8);
      return original(method, params, session);
    });
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).resolves.toBe(
      listing(),
    );
    expect(worlds).toBe(2);
  });

  it("没有重载的读取错误仍然立即结束，不掩盖其他故障", async () => {
    const browser = new BrowserMock();
    const original = browser.send.getMockImplementation()!;
    browser.send.mockImplementation(async (method, params, session) => {
      if (method === "Runtime.evaluate") throw new Error("safe mock: read failed");
      return original(method, params, session);
    });
    await expect(readAvwikiBrowserPage(browser, url, new AbortController().signal)).rejects.toThrow(
      "safe mock: read failed",
    );
    expect(browser.listeners.size).toBe(0);
  });
});
