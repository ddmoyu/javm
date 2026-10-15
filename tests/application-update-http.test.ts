import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { HttpRequest } from "../frontend/src/services/network/HttpService";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import type { UpdateService } from "../frontend/src/services/settings/UpdateService";

// 保留正式更新服务及取流 HTTP 适配器；只替换原生传输、文件与安装端口。
// 全部正文为安全虚构数据，不连接网络、不修改真实设置或程序。
const native = vi.hoisted(() => ({
  files: new Map<string, ArrayBuffer>(),
  http: vi.fn(),
  rpc: vi.fn(),
  remove: vi.fn(),
  proxy: vi.fn(),
  ready: false,
  current: "1.0.5",
}));
vi.mock("../package.json", () => ({
  default: {
    get version() {
      return native.current;
    },
  },
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({ requestHttp: native.http }));
vi.mock("@neutralinojs/lib", () => ({
  os: { getPath: async () => "C:/safe-update-fixture" },
  filesystem: {
    createDirectory: async () => {},
    remove: native.remove,
    getStats: async (file: string) => ({ isFile: true, size: native.files.get(file)!.byteLength }),
    readBinaryFile: async (file: string, options: { pos: number; size: number }) =>
      native.files.get(file)!.slice(options.pos, options.pos + options.size),
  },
}));
vi.mock("../frontend/src/platform/neutralino/settingsStorage", () => ({
  nativeSettingsStorage: () => ({
    read: async () => ({ channel: "stable", automatic: false, lastCheck: 0 }),
    write: async () => {},
  }),
}));
vi.mock("../frontend/src/platform/neutralino/updateStartup", () => ({
  configureUpdater: async () => ({ available: true, kind: "setup", platform: "windows-x64" }),
  updateRpc: { request: native.rpc },
  cancelUpdateHandoff: vi.fn(),
  markUpdateExitReady: vi.fn(),
}));
vi.mock("../frontend/src/platform/neutralino/lifecycle", () => ({ exitApplication: vi.fn() }));

const list = "https://api.github.com/repos/ddmoyu/javm/releases?per_page=30&page=";
const manifest = (version: string) =>
  `https://github.com/ddmoyu/javm/releases/download/v${version}/JAVM-update.json`;
const cdn = "https://release-assets.githubusercontent.com/safe-fixture/manifest.json";
const signed = (version: string) => ({
  payload: JSON.stringify({ version }),
  signature: "fixture",
});
const asset = {
  platform: "windows-x64",
  kind: "setup",
  name: "JAVM-1.0.6-windows-x64-setup.exe",
  bytes: 4,
  sha256: "a".repeat(64),
};
let service: UpdateService | undefined;

function respond(request: HttpRequest, body: unknown, status = 200, headers = {}) {
  native.files.set(request.output!, new TextEncoder().encode(JSON.stringify(body)).buffer);
  return { exitCode: 0, status, headers, ambiguousHeaders: false };
}
async function updater() {
  const { createApplicationUpdater } =
    await import("../frontend/src/platform/neutralino/applicationUpdates");
  service = createApplicationUpdater("desktop", {
    getProxy: native.proxy,
  } as unknown as NetworkSettingsService);
  await service.initialize();
  return service;
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.files.clear();
  native.ready = false;
  native.current = "1.0.5";
  native.proxy.mockResolvedValue("http://127.0.0.1:7897");
  native.remove.mockImplementation(async (directory: string) => {
    for (const name of native.files.keys())
      if (name.startsWith(directory + "/")) native.files.delete(name);
  });
  native.rpc.mockImplementation(async (method: string) => {
    if (method === "update.status") return { phase: native.ready ? "ready" : "idle" };
    if (method === "update.verify") return asset;
    if (method === "update.download") native.ready = true;
    return {};
  });
  native.http.mockImplementation(async (request: HttpRequest) => {
    if (request.url === list + "1")
      return respond(request, [
        { tag_name: "v1.0.6", assets: [{ name: "JAVM-update.json" }], body: "安全更新样例" },
        ...Array.from({ length: 29 }, (_, index) => ({ tag_name: `deps-safe-${index}` })),
      ]);
    if (request.url === list + "2") return respond(request, []);
    if (request.url === manifest("1.0.6")) return respond(request, {}, 302, { location: cdn });
    if (request.url === cdn) return respond(request, signed("1.0.6"));
    if (request.url === manifest("1.0.5")) return respond(request, signed("1.0.5"));
    throw new Error("未声明的测试地址");
  });
});
afterEach(async () => {
  await service?.shutdown();
  service = undefined;
});

it("1.0.5 检查更新经过正式 HTTP 适配器、分页与 CDN 跳转，发现并验签 1.0.6", async () => {
  const value = await updater();
  await value.check();
  expect(value.getSnapshot().error).toBe("");
  expect(value.getSnapshot().release).toMatchObject({ version: "1.0.6", asset });
  expect(native.http.mock.calls.map(([request]) => (request as HttpRequest).url)).toEqual([
    list + "1",
    list + "2",
    manifest("1.0.6"),
    cdn,
  ]);
  expect(
    native.http.mock.calls.every(
      ([request]) => (request as HttpRequest).proxy === "http://127.0.0.1:7897",
    ),
  ).toBe(true);
  expect(native.rpc).toHaveBeenCalledWith("update.verify", {
    envelope: signed("1.0.6"),
    version: "1.0.6",
    channel: "stable",
  });
  expect(native.rpc.mock.calls.some(([method]) => method === "update.download")).toBe(false);
  expect(native.files.size).toBe(0);
});

it("安装版下载前同样能读取当前版本的回退清单，并保留手动安装边界", async () => {
  const value = await updater();
  await value.check();
  await value.download();
  expect(value.getSnapshot().error).toBe("");
  expect(value.getSnapshot().status.phase).toBe("ready");
  expect(native.rpc).toHaveBeenCalledWith("update.download", {
    envelope: signed("1.0.6"),
    rollback: signed("1.0.5"),
    channel: "stable",
    proxy: "http://127.0.0.1:7897",
  });
  expect(native.rpc.mock.calls.some(([method]) => method === "update.handoff")).toBe(false);
});

it("1.0.7 可以发现 1.0.8，获取新包及 1.0.7 回退清单后等待用户安装", async () => {
  native.current = "1.0.7";
  const nextAsset = { ...asset, name: "JAVM-1.0.8-windows-x64-setup.exe" };
  native.http.mockImplementation(async (request: HttpRequest) => {
    if (request.url === list + "1")
      return respond(request, [{ tag_name: "v1.0.8", assets: [{ name: "JAVM-update.json" }] }]);
    if (request.url === manifest("1.0.8")) return respond(request, signed("1.0.8"));
    if (request.url === manifest("1.0.7")) return respond(request, signed("1.0.7"));
    throw new Error("未声明的测试地址");
  });
  native.rpc.mockImplementation(async (method: string) => {
    if (method === "update.verify") return nextAsset;
    if (method === "update.download") native.ready = true;
    if (method === "update.status") return { phase: native.ready ? "ready" : "idle" };
    return {};
  });
  const value = await updater();
  await value.check();
  expect(value.getSnapshot().release).toMatchObject({ version: "1.0.8", asset: nextAsset });
  await value.download();
  expect(value.getSnapshot().error).toBe("");
  expect(value.getSnapshot().status.phase).toBe("ready");
  expect(native.rpc).toHaveBeenCalledWith("update.download", {
    envelope: signed("1.0.8"),
    rollback: signed("1.0.7"),
    channel: "stable",
    proxy: "http://127.0.0.1:7897",
  });
  expect(native.rpc.mock.calls.some(([method]) => method === "update.handoff")).toBe(false);
});

it("网络超时显示更新提示，不把取流错误暴露给更新界面", async () => {
  native.http.mockResolvedValue({ exitCode: 28, status: 0 });
  const value = await updater();
  await value.check();
  expect(value.getSnapshot().error).toBe("检查更新超时，请检查网络或代理后重试。");
  expect(native.http).toHaveBeenCalledOnce();
  expect(native.files.size).toBe(0);
});

it("限流保留更新专用提示，不继续验签或下载", async () => {
  native.http.mockImplementation(async (request: HttpRequest) => respond(request, {}, 429));
  const value = await updater();
  await value.check();
  expect(value.getSnapshot().error).toBe("官方更新服务暂时限流，请稍后重试。");
  expect(native.rpc.mock.calls.some(([method]) => method === "update.verify")).toBe(false);
});

it("更新重定向降级为 HTTP 时在第二跳之前拒绝", async () => {
  native.http.mockImplementation(async (request: HttpRequest) =>
    respond(request, {}, 302, { location: "http://unsafe.example.invalid/manifest" }),
  );
  const value = await updater();
  await value.check();
  expect(value.getSnapshot().error).toBe("更新请求地址无效。");
  expect(native.http).toHaveBeenCalledOnce();
});

it("超限响应拒绝解析，显示更新错误并清理临时文件", async () => {
  native.http.mockImplementation(async (request: HttpRequest) =>
    respond(request, "x".repeat(1024 * 1024)),
  );
  const value = await updater();
  await value.check();
  expect(value.getSnapshot().error).toBe("更新信息超过大小限制，请前往官方发布页面检查更新。");
  expect(native.files.size).toBe(0);
  expect(native.rpc.mock.calls.some(([method]) => method === "update.verify")).toBe(false);
});
