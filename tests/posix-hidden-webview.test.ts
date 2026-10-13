import { afterEach, expect, it, vi } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import {
  createPosixHiddenWebview,
  posixHiddenConfig,
  posixCaptureScript,
  readPosixCandidates,
} from "../frontend/src/platform/neutralino/posixHiddenWebview";

vi.mock("@neutralinojs/lib", () => ({ filesystem: {}, os: {} }));
vi.mock("../frontend/src/platform/neutralino/process", () => ({ runNativeProcess: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it("候选通过 WebKit 消息通道回传，不依赖网页 WebSocket 或原生认证全局量", () => {
  let tick: (() => void) | undefined;
  const postMessage = vi.fn();
  runInNewContext(posixCaptureScript({ provider: "webview", url: "https://safe.example" }), {
    __javmStreamCapture: {
      read: () => ({ urls: ["https://safe.example/list.m3u8"], pageUrl: "https://safe.example" }),
    },
    webkit: { messageHandlers: { javmCapture: { postMessage } } },
    navigator: { userAgent: "safe-browser" },
    setInterval: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    clearInterval: vi.fn(),
    addEventListener: vi.fn(),
  });
  tick!();
  expect(JSON.parse(postMessage.mock.calls[0]![0])).toEqual({
    urls: ["https://safe.example/list.m3u8"],
    pageUrl: "https://safe.example",
    userAgent: "safe-browser",
  });
});

it("隐藏页面仅保留宿主退出权限，强制独立会话且没有原生扩展", () => {
  const config = posixHiddenConfig("https://safe.example/forest");
  expect(config.nativeAllowList).toEqual(["app.exit"]);
  expect(config.enableExtensions).toBe(false);
  expect(config.modes.window).toMatchObject({
    hidden: true,
    skipTaskbar: true,
    webviewArgs: "--javm-isolated",
    newWindowPolicy: "custom",
    injectGlobals: false,
  });
  expect(() => posixHiddenConfig("file:///private/sample")).toThrow();
});

it("网页只能返回有界 HTTP 候选与公开上下文，不能夹带凭据", () => {
  const result = readPosixCandidates({
    pageUrl: "https://safe.example/forest",
    userAgent: "safe-agent\r\nCookie: unsafe",
    urls: [
      "file:///private",
      "https://name:password@safe.example/list.m3u8",
      "https://safe.example/list.m3u8",
      "https://safe.example/list.m3u8",
    ],
    cookie: "not-forwarded",
    headers: { Authorization: "not-forwarded" },
  });
  expect(result.candidates).toEqual([
    {
      url: "https://safe.example/list.m3u8",
      publicHeaders: { referer: "https://safe.example/forest", origin: "https://safe.example" },
    },
  ]);
  expect(
    readPosixCandidates({
      pageUrl: "https://safe.example",
      urls: Array.from({ length: 32 }, (_, index) => `https://safe.example/${index}.m3u8`),
    }).candidates,
  ).toHaveLength(16);
});

it("验证码与明确缺失页面不会返回表面成功的候选", () => {
  expect(readPosixCandidates({ interaction: true }).failure).toBe("interaction_required");
  expect(readPosixCandidates({ missing: true }).failure).toBe("not_found");
});

it("未经隔离补丁的开发宿主不能启动隐藏浏览器", async () => {
  vi.stubGlobal("window", { NL_OS: "Darwin", NL_COMMIT: "upstream" });
  await expect(
    createPosixHiddenWebview()(
      { provider: "webview", url: "https://safe.example" },
      new AbortController().signal,
      "",
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it("不能复现的代理与自定义会话在启动进程前明确失败", async () => {
  vi.stubGlobal("window", { NL_OS: "Darwin", NL_COMMIT: "safe+javm-posix" });
  const resolve = createPosixHiddenWebview();
  const request = { provider: "webview" as const, url: "https://safe.example" };
  await expect(
    resolve(request, new AbortController().signal, "http://127.0.0.1:7890"),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    resolve({ ...request, headers: { Cookie: "safe-fixture" } }, new AbortController().signal, ""),
  ).rejects.toMatchObject({ code: "session_required" });
});
