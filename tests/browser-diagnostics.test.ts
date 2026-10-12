import { describe, expect, it } from "vite-plus/test";
import { BrowserDiagnostics } from "../frontend/src/services/catalog/browserDiagnostics";

describe("隐藏读取有界诊断（安全 mock）", () => {
  it("记录请求类别、响应与未完成请求，原始地址和响应头不进入结果", () => {
    let time = 0;
    const detail = new BrowserDiagnostics("https://source.example", () => time);
    detail.target("root", "page");
    const emit = (method: string, params: Record<string, unknown>) =>
      detail.event({ method, params, sessionId: "root" });
    emit("Network.requestWillBeSent", {
      requestId: "main",
      type: "Document",
      request: { url: "https://source.example/private-title?token=secret" },
    });
    time = 20;
    emit("Network.responseReceived", {
      requestId: "main",
      response: {
        status: 403,
        headers: { "cf-ray": "1234567890abcdef-ABC", "set-cookie": "secret" },
      },
    });
    emit("Network.loadingFinished", { requestId: "main" });
    emit("Network.requestWillBeSent", {
      requestId: "pat",
      type: "Fetch",
      request: {
        url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/pat/private-token",
      },
    });
    time = 40;
    emit("Network.responseReceived", { requestId: "pat", response: { status: 401 } });
    emit("Network.loadingFinished", { requestId: "pat" });
    emit("Network.requestWillBeSent", {
      requestId: "pending",
      type: "Fetch",
      request: {
        url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow/private-token",
      },
    });
    time = 1040;
    const result = detail.finish();
    expect(result).toMatchObject({
      pendingRequests: 1,
      idleMs: 1000,
      ray: "1234567890abcdef-ABC",
      documents: 1,
    });
    expect(result.traces).toEqual([
      expect.objectContaining({ id: 1, kind: "source_document", status: 403, event: "finished" }),
      expect.objectContaining({ id: 2, kind: "challenge_pat", status: 401, event: "finished" }),
      expect.objectContaining({ id: 3, kind: "challenge_flow", event: "pending" }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|https:|cookie|source\.example/);
  });
  it("取消、拦截和 DNS 探测分类，陌生错误文本与控制台消息不透传", () => {
    const detail = new BrowserDiagnostics("https://source.example");
    detail.target("child", "iframe");
    const emit = (method: string, params: Record<string, unknown>) =>
      detail.event({ method, params, sessionId: "child" });
    for (const [id, url, extra] of [
      [
        "probe",
        "https://safe-probe.challenges.cloudflare.com/sensitive",
        { errorText: "net::ERR_ABORTED", canceled: true },
      ],
      [
        "icon",
        "https://source.example/favicon.ico?private=1",
        { blockedReason: "inspector", errorText: "" },
      ],
      [
        "other",
        "https://private.example/secret",
        { errorText: "secret error https://private.example" },
      ],
    ] as const) {
      emit("Network.requestWillBeSent", { requestId: id, type: "Fetch", request: { url } });
      emit("Network.loadingFailed", { requestId: id, ...extra });
    }
    emit("Runtime.consoleAPICalled", {
      args: [{ value: "secret console text" }, { value: "[Cloudflare Turnstile] Error: 600010." }],
    });
    const result = detail.finish();
    expect(result.turnstileCode).toBe("600010");
    expect(result.traces).toEqual([
      expect.objectContaining({ kind: "challenge_probe", event: "canceled", error: "ERR_ABORTED" }),
      expect.objectContaining({ kind: "media", event: "blocked", error: "ERR_BLOCKED_BY_CLIENT" }),
      expect.objectContaining({ kind: "other", event: "failed", error: "NETWORK_FAILED" }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|https:|console/);
  });
  it("请求和目标有硬上限，结束后的退出事件不污染快照", () => {
    const detail = new BrowserDiagnostics("https://source.example");
    detail.target("root", "page");
    for (let i = 0; i < 150; i++) {
      detail.event({
        method: "Network.requestWillBeSent",
        sessionId: "root",
        params: {
          requestId: String(i),
          type: "Script",
          request: { url: "https://source.example/safe.js" },
        },
      });
      detail.event({
        method: "Network.loadingFinished",
        sessionId: "root",
        params: { requestId: String(i) },
      });
    }
    const result = detail.finish();
    expect(result.traces).toHaveLength(24);
    expect(result.omitted).toBe(126);
    detail.event({
      method: "Network.requestWillBeSent",
      sessionId: "root",
      params: { requestId: "late" },
    });
    expect(detail.finish().traces).toEqual(result.traces);
  });
  it("诊断采样失败是非致命的，页面返回额外字段不会被写入日志", async () => {
    const detail = new BrowserDiagnostics("https://source.example", () => 100);
    detail.target("root", "page");
    detail.target("child", "iframe");
    detail.sample(
      {
        send: async (_method, _params, id) => {
          if (id === "child") throw new Error("secret error");
          return {
            result: {
              value: {
                webdriver: false,
                visibility: "visible",
                focused: true,
                storage: true,
                siteData: true,
                ready: "complete",
                checkboxes: 1,
                visibleCheckboxes: 1,
                password: false,
                captcha: false,
                body: "secret body",
                url: "https://private.example",
              },
            },
          };
        },
      },
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = detail.finish();
    expect(result.probeErrors).toBe(1);
    expect(result.pages).toEqual([
      expect.objectContaining({ webdriver: false, visibleCheckboxes: 1, target: "page-1" }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|https:|body/);
  });
});
