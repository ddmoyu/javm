import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchCatalogWithWebview } from "../frontend/src/platform/neutralino/catalogWebview";
import { HiddenWebviewError } from "../frontend/src/platform/neutralino/hiddenWebview";
import { CatalogReadCancellation } from "../frontend/src/services/catalog/browserDiagnostics";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import type { CdpEvent } from "../frontend/src/services/streamResolution/cdp";
import { cleanLog, type LogInput } from "../frontend/src/services/logging/events";

const native = vi.hoisted(() => ({ host: vi.fn(), log: vi.fn() }));
vi.mock("../frontend/src/platform/neutralino/hiddenWebview", async (original) => ({
  ...(await original<typeof import("../frontend/src/platform/neutralino/hiddenWebview")>()),
  withHiddenWebview: native.host,
}));
vi.mock("../frontend/src/services/logging/events", async (original) => ({
  ...(await original<typeof import("../frontend/src/services/logging/events")>()),
  logEvent: native.log,
}));
afterEach(() => vi.resetAllMocks());
const url = "https://avwikidb.com/actor/1/";
class Browser {
  listeners = new Set<(event: CdpEvent) => void>();
  manual = false;
  failure = "";
  navigate = () => {};
  on = (listener: (event: CdpEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(method: string, params: Record<string, unknown>) {
    for (const listener of this.listeners) listener({ method, params, sessionId: "root" });
  }
  send = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    if (method === this.failure) throw new ResolutionError("unavailable");
    if (method === "Browser.getVersion") return { product: "Edg/154.0.4258.62" };
    if (method === "Target.getTargets")
      return { targetInfos: [{ type: "page", targetId: "page" }] };
    if (method === "Target.attachToTarget") return { sessionId: "root" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Page.navigate") {
      this.emit("Network.requestWillBeSent", {
        requestId: "document",
        type: "Document",
        frameId: "frame",
        request: { url },
      });
      this.emit("Network.responseReceived", {
        requestId: "document",
        type: "Document",
        frameId: "frame",
        loaderId: "document",
        response: { url, status: 403, headers: { "cf-mitigated": "challenge" } },
      });
      this.emit("Page.frameNavigated", { frame: { id: "frame", loaderId: "document" } });
      this.navigate();
    }
    if (method === "Runtime.evaluate")
      return {
        result: {
          value: String(params.expression).includes("JAVM_DIAGNOSTIC")
            ? {
                webdriver: false,
                visibility: "visible",
                focused: true,
                storage: true,
                siteData: true,
                ready: "complete",
                password: false,
                captcha: false,
                checkboxes: 0,
                visibleCheckboxes: 0,
              }
            : { href: url, interaction: this.manual },
        },
      };
    return {};
  };
}
function logs() {
  return native.log.mock.calls.map(([level, module, event, message, context]) =>
    cleanLog({ level, module, event, message, context } as LogInput),
  );
}
function host(browser: Browser, bounded?: AbortSignal) {
  native.host.mockImplementation(async (signal, _proxy, read, stage) => {
    stage("read");
    return read(browser, bounded ?? signal);
  });
}

describe("隐藏读取结束日志（安全 mock）", () => {
  it("成功与清理失败分别记录，清理失败不会被标记为成功", async () => {
    native.host.mockResolvedValueOnce("<main>Safe result</main>");
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).resolves.toContain(
      "Safe result",
    );
    expect(logs().at(-1)).toMatchObject({ context: { reason: "success" } });
    native.host.mockRejectedValueOnce(new StopUnconfirmedError(async () => {}));
    await expect(
      fetchCatalogWithWebview(url, new AbortController().signal, ""),
    ).rejects.toBeInstanceOf(StopUnconfirmedError);
    expect(logs().at(-1)).toMatchObject({
      level: "warn",
      context: { reason: "cleanup_unconfirmed" },
    });
  });
  it.each(["replaced", "view_closed", "shutdown"] as const)(
    "调用方取消 %s 也有结束原因",
    async (cause) => {
      const browser = new Browser(),
        abort = new AbortController();
      browser.navigate = () => abort.abort(new CatalogReadCancellation(cause));
      host(browser);
      await expect(fetchCatalogWithWebview(url, abort.signal, "")).rejects.toThrow(cause);
      const entries = logs();
      const start = entries.find((e) => e.event === "browser_started")!;
      expect(entries.at(-1)).toMatchObject({
        event: "browser_finished",
        level: "info",
        context: { attempt: start.context!.attempt, reason: "cancelled", code: cause, status: 403 },
      });
      expect(browser.listeners.size).toBe(0);
    },
  );
  it("人工验证提前退出记录明确原因，不留下只有进程退出的日志", async () => {
    const browser = new Browser();
    browser.manual = true;
    host(browser);
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      "需要人工验证",
    );
    expect(logs().at(-1)).toMatchObject({
      event: "browser_finished",
      context: { reason: "interaction_required", status: 403 },
    });
  });
  it("页面跳转被拒绝有结束原因", async () => {
    const browser = new Browser();
    host(browser);
    browser.navigate = () =>
      browser.emit("Fetch.requestPaused", {
        requestId: "redirect",
        resourceType: "Document",
        frameId: "frame",
        request: { url: "https://private.example/secret" },
      });
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      "跳转",
    );
    expect(logs().at(-1)).toMatchObject({
      event: "browser_finished",
      context: { reason: "navigation_rejected" },
    });
    expect(JSON.stringify(logs())).not.toMatch(/private|secret/);
  });
  it("控制命令失败记录命令与子目标类型", async () => {
    const browser = new Browser();
    browser.failure = "Network.enable";
    host(browser);
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      "未能读取",
    );
    expect(logs().find((e) => e.event === "browser_runtime")).toMatchObject({
      context: { lastCdpCommand: "Network.enable", lastCdpTarget: "page" },
    });
    expect(logs().at(-1)).toMatchObject({ context: { reason: "cdp_error", code: "unavailable" } });
  });
  it("超时保留编号、浏览器状态、待完成请求，所有字段通过正式脱敏器", async () => {
    const browser = new Browser(),
      bounded = new AbortController();
    host(browser, bounded.signal);
    const timer = setTimeout(() => bounded.abort(new HiddenWebviewError("timeout", "read")), 40);
    try {
      await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
        "自动验证",
      );
    } finally {
      clearTimeout(timer);
    }
    const entries = logs();
    expect(entries.at(-1)).toMatchObject({
      context: { reason: "timeout", code: "timeout", status: 403 },
    });
    expect(entries.find((e) => e.event === "browser_page_state")).toMatchObject({
      context: { webdriver: false, siteData: true, storage: true },
    });
    expect(entries.find((e) => e.event === "browser_request_trace")).toMatchObject({
      context: { kind: "source_document", event: "response", status: 403 },
    });
    for (const entry of entries)
      expect(Object.keys(entry.context ?? {}).length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(entries)).not.toContain("avwikidb.com");
  });
  it("未知错误仍记录结束且不写入异常原文", async () => {
    native.host.mockRejectedValue(new Error("secret body https://private.example"));
    await expect(fetchCatalogWithWebview(url, new AbortController().signal, "")).rejects.toThrow(
      "secret",
    );
    expect(logs().at(-1)).toMatchObject({ context: { reason: "unexpected_error" } });
    expect(JSON.stringify(logs())).not.toMatch(/secret|private/);
  });
});
