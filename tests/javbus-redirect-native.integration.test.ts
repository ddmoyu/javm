import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MediaHost } from "./helpers/mediaHost";
import { createCatalogHttp } from "../frontend/src/platform/neutralino/catalogHttp";
import { HttpService } from "../frontend/src/services/network/HttpService";
import type { HttpRequest, HttpResponse } from "../frontend/src/services/network/HttpService";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";

const mock = vi.hoisted(() => ({
  root: "",
  transport: undefined as
    | ((request: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>)
    | undefined,
  log: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  os: { getPath: async () => mock.root },
  filesystem: {
    createDirectory: (directory: string) => mkdir(directory),
    remove: async (target: string) => {
      if (!path.resolve(target).startsWith(path.resolve(mock.root) + path.sep))
        throw new Error("安全 mock 清理路径越界");
      await rm(target, { recursive: true, force: true });
    },
    getStats: async (file: string) => {
      const value = await stat(file);
      return { isFile: value.isFile(), size: value.size };
    },
    readFile: (file: string) => readFile(file, "utf8"),
  },
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: (request: HttpRequest, signal: AbortSignal) => mock.transport!(request, signal),
}));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: mock.log }));

// 正式适配器 + HTTP 调度器 + 原生 Extension；仅在测试端口把请求映射到回环 mock。
// 服务器不代理流量，不打开 WebView、媒体数据库或任何真实来源。
describe.runIf(process.env.JAVM_HTTP_INTEGRATION === "1")("JavBus 302 适配器与原生传输闭环", () => {
  let host: MediaHost, service: HttpService, server: Server, local: string;
  let mode: "success" | "verification" | "slow", slow: ServerResponse | undefined;
  let paths: string[], statuses: number[], connections: number[];
  const base = path.resolve(import.meta.dirname, "../.tmp");
  const url = "https://www.javbus.com/star/safe";
  const browser = vi.fn();
  const network = { getProxy: async () => "" } as unknown as NetworkSettingsService;
  beforeEach(async () => {
    vi.clearAllMocks();
    mock.root = await mkdtemp(path.join(base, "javbus-302-safe-"));
    mode = "success";
    slow = undefined;
    paths = [];
    statuses = [];
    connections = [];
    server = createServer((req, res) => {
      paths.push(req.url!);
      if (req.url === "/star/safe") {
        res.writeHead(302, {
          Location: mode === "verification" ? "/agecheck?private=safe-mock" : "/star/safe/",
        });
        res.end("Safe redirect fixture");
      } else if (mode === "slow") {
        slow = res;
        res.writeHead(200);
        res.write("Safe pending fixture");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<main>安全合成作品页</main>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("安全 mock 监听失败");
    local = `http://127.0.0.1:${address.port}`;
    host = new MediaHost();
    await host.start(path.join(mock.root, "must-not-open.sqlite"));
    service = new HttpService({
      async execute(request, signal) {
        expect(request.maxRedirects).toBe(0);
        const id = crypto.randomUUID(),
          output = path.join(mock.root, `${id}.part`);
        const target = new URL(request.url);
        if (target.origin !== "https://www.javbus.com")
          throw new Error("安全 mock 不允许其他逻辑来源");
        let stopped: Promise<unknown> | undefined;
        const abort = () => {
          stopped ??= host.request("http.cancel", { id });
          void stopped.catch(() => {});
        };
        signal.throwIfAborted();
        signal.addEventListener("abort", abort, { once: true });
        try {
          const result = await host.request<HttpResponse>("http.request", {
            ...request,
            id,
            output,
            proxy: "",
            url: `${local}${target.pathname}`,
          });
          if (stopped) await stopped;
          statuses.push(result.status);
          connections.push(result.connections);
          if (signal.aborted) {
            await rm(output, { force: true });
            signal.throwIfAborted();
          }
          return { ...result, effectiveUrl: request.url, path: output };
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      copy: (from, to) => copyFile(from, to),
      remove: (file) => rm(file, { force: true }),
    });
    mock.transport = (request, signal) => service.request(request, signal);
  });
  afterEach(async () => {
    await service?.shutdown();
    await host?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    expect(await stat(path.join(mock.root, "must-not-open.sqlite")).catch(() => null)).toBeNull();
    expect(await readdir(mock.root)).toEqual([]);
    const resolved = path.resolve(mock.root);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith("javbus-302-safe-"))
      throw new Error("安全 mock 清理路径越界");
    await rm(resolved, { recursive: true, force: true });
  });
  it("302 到 200 通过正式文件读取与清理，保留连接复用和限频", async () => {
    await expect(
      createCatalogHttp(network, async () => {}, browser)(url, new AbortController().signal),
    ).resolves.toBe("<main>安全合成作品页</main>");
    expect(paths).toEqual(["/star/safe", "/star/safe/"]);
    expect(statuses).toEqual([302, 200]);
    expect(connections).toEqual([1, 0]);
    expect(browser).not.toHaveBeenCalled();
    expect(mock.log).toHaveBeenCalledWith(
      "info",
      "catalog",
      "javbus_redirect",
      "JavBus 正在跟随站内跳转",
      expect.objectContaining({ status: 302, hop: 1 }),
    );
  });
  it("验证入口只请求一次即结束，日志不输出 Location 或会话数据", async () => {
    mode = "verification";
    await expect(
      createCatalogHttp(network, async () => {}, browser)(url, new AbortController().signal),
    ).rejects.toThrow("验证或登录入口");
    expect(paths).toEqual(["/star/safe"]);
    expect(browser).not.toHaveBeenCalled();
    expect(JSON.stringify(mock.log.mock.calls)).not.toContain("private");
  });
  it("第二跳慢响应可取消，退出前移除原生传输和响应文件", async () => {
    mode = "slow";
    const abort = new AbortController();
    const pending = createCatalogHttp(network, async () => {}, browser)(url, abort.signal);
    const rejected = expect(pending).rejects.toThrow("安全取消");
    await vi.waitFor(() => expect(slow).toBeDefined());
    abort.abort(new Error("安全取消"));
    await rejected;
    expect(paths).toEqual(["/star/safe", "/star/safe/"]);
    expect(browser).not.toHaveBeenCalled();
  });
});
