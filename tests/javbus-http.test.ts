import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createCatalogHttp } from "../frontend/src/platform/neutralino/catalogHttp";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";

const mock = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), remove: vi.fn(), log: vi.fn() }));
vi.mock("@neutralinojs/lib", () => ({
  os: { getPath: async () => "C:/safe-mock" },
  filesystem: {
    createDirectory: async () => {},
    remove: mock.remove,
    getStats: async () => ({ isFile: true, size: 100 }),
    readFile: mock.read,
  },
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({ requestHttp: mock.request }));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: mock.log }));
const network = {
  getProxy: async () => "http://127.0.0.1:1234",
} as unknown as NetworkSettingsService;
beforeEach(() => {
  vi.resetAllMocks();
  mock.request.mockImplementation(async (request) => ({
    exitCode: 0,
    status: 200,
    bytes: 100,
    headers: {},
    effectiveUrl: request.url,
  }));
  mock.read.mockResolvedValue("安全 mock 页面");
  mock.remove.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it("JavBus 搜索、实体和详情走常驻 HTTP，传入代理和导航请求头并清理响应文件", async () => {
  const fetch = createCatalogHttp(network, async () => {});
  for (const path of [
    "/searchstar/%E7%A4%BA%E4%BE%8B",
    "/uncensored/star/safe/2",
    "/genre/safe",
    "/director/safe",
    "/TEST-001_2026-01-01",
  ]) {
    const url = `https://www.javbus.com${path}`;
    await expect(fetch(url, new AbortController().signal)).resolves.toBe("安全 mock 页面");
    expect(mock.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url,
        purpose: "catalog",
        proxy: "http://127.0.0.1:1234",
        headers: expect.objectContaining({
          Referer: "https://www.javbus.com/",
          "Accept-Language": "zh-CN,zh;q=0.9",
        }),
      }),
      expect.any(AbortSignal),
    );
  }
  expect(mock.remove).toHaveBeenCalledTimes(5);
});
it("JavBus 403 自动结束，不启动隐藏读取器；日志保留来源 URL", async () => {
  mock.request.mockResolvedValue({
    exitCode: 0,
    status: 403,
    bytes: 100,
    headers: {},
    effectiveUrl: "https://www.javbus.com/TEST-001",
  });
  await expect(
    createCatalogHttp(network, async () => {})(
      "https://www.javbus.com/TEST-001",
      new AbortController().signal,
    ),
  ).rejects.toThrow("作品来源拒绝访问（HTTP 403）");
  expect(mock.read).not.toHaveBeenCalled();
  expect(mock.remove).toHaveBeenCalledOnce();
  expect(JSON.stringify(mock.log.mock.calls)).toContain("https://www.javbus.com/TEST-001");
});
it("拒绝跨站、超范围分页和磁力接口，不启动 HTTP", async () => {
  const fetch = createCatalogHttp(network, async () => {});
  for (const url of [
    "https://safe.invalid/star/safe",
    "https://www.javbus.com/star/safe/1001",
    "https://www.javbus.com/ajax/uncledatoolsbyajax.php",
  ]) {
    await expect(fetch(url, new AbortController().signal)).rejects.toThrow("地址无效");
  }
  expect(mock.request).not.toHaveBeenCalled();
});
