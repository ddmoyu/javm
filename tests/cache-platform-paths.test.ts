import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { filesystem, os, server } from "@neutralinojs/lib";
import { createImageSourcePort } from "../frontend/src/platform/neutralino/imageSources";
import { createPortraitPort } from "../frontend/src/platform/neutralino/portraits";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";

vi.mock("@neutralinojs/lib", () => ({
  os: { getEnv: vi.fn(), getPath: vi.fn() },
  filesystem: { createDirectory: vi.fn(), readDirectory: vi.fn(async () => []) },
  server: { mount: vi.fn(), unmount: vi.fn() },
}));
// 所有调用必须命中空缓存；意外联网即失败，不使用实际图片或目录。
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: () => {
    throw new Error("此夹具不允许网络访问");
  },
}));
const network = { getProxy: async () => "" } as NetworkSettingsService;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEV", false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("图片与头像缓存调用跨平台目录适配器", () => {
  it.each([
    ["Windows", "C:/SafeFixture/Local", "C:/SafeFixture/Local/JAVM/cache"],
    ["Linux", "/home/safe/.cache", "/home/safe/.cache/JAVM"],
    ["Darwin", "/Users/Safe User/Library/Caches", "/Users/Safe User/Library/Caches/JAVM"],
  ])("%s 缓存初始化不再要求盘符", async (platform, base, expected) => {
    vi.stubGlobal("window", { NL_OS: platform });
    vi.mocked(os.getPath).mockResolvedValue(base);
    vi.mocked(os.getEnv).mockResolvedValue(base);
    const images = createImageSourcePort(network, async () => {});
    const portraits = createPortraitPort(network, async () => {});
    try {
      const signal = new AbortController().signal;
      expect(
        await images.copyCached!(
          "https://safe.invalid/image.jpg",
          undefined,
          "/unused-safe-destination",
          signal,
        ),
      ).toBe(false);
      expect(await portraits.cached!("actresses", [], signal)).toEqual({});
      expect(filesystem.createDirectory).toHaveBeenCalledWith(`${expected}/image-previews-v1`);
      expect(filesystem.createDirectory).toHaveBeenCalledWith(`${expected}/portraits`);
      expect(server.mount).toHaveBeenCalledTimes(2);
    } finally {
      await images.shutdown();
      await portraits.shutdown();
    }
    expect(server.unmount).toHaveBeenCalledTimes(2);
  });
});
