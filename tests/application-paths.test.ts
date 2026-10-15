import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { os } from "@neutralinojs/lib";
import {
  applicationCachePath,
  applicationDataPath,
} from "../frontend/src/platform/neutralino/applicationPaths";

vi.mock("@neutralinojs/lib", () => ({ os: { getEnv: vi.fn(), getPath: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("跨平台应用目录（仅安全路径 mock，不读写磁盘）", () => {
  it("Windows 保留既有 LocalAppData 下的目录副本与图片缓存", async () => {
    vi.stubGlobal("window", { NL_OS: "Windows" });
    vi.mocked(os.getEnv).mockResolvedValue("C:\\Safe User\\本地\\");
    expect(await applicationDataPath("catalogs", "javbus")).toBe(
      "C:/Safe User/本地/JAVM/catalogs/javbus",
    );
    expect(await applicationCachePath("portraits")).toBe("C:/Safe User/本地/JAVM/cache/portraits");
    expect(os.getEnv).toHaveBeenCalledWith("LOCALAPPDATA");
    expect(os.getPath).not.toHaveBeenCalled();
  });

  it("Windows 支持重定向到 UNC 的用户目录", async () => {
    vi.stubGlobal("window", { NL_OS: "Windows" });
    vi.mocked(os.getEnv).mockResolvedValue("\\\\safe-server\\profiles\\Safe User");
    expect(await applicationDataPath("catalogs")).toBe(
      "//safe-server/profiles/Safe User/JAVM/catalogs",
    );
  });

  it.each([
    ["Darwin", "/Users/Safe User/Library/Application Support", "/Users/Safe User/Library/Caches"],
    ["Linux", "/home/safe/.local/share", "/home/safe/.cache"],
    ["Linux", "/mnt/自定义 data/", "/mnt/自定义 cache/"],
  ])("%s 使用宿主返回的 data/cache 目录：%s", async (platform, data, cache) => {
    vi.stubGlobal("window", { NL_OS: platform });
    vi.mocked(os.getPath).mockImplementation(async (kind) => (kind === "data" ? data : cache));
    expect(await applicationDataPath("catalogs", "javbus")).toBe(
      `${data.replace(/\/$/, "")}/JAVM/catalogs/javbus`,
    );
    expect(await applicationCachePath("image-previews-v1")).toBe(
      `${cache.replace(/\/$/, "")}/JAVM/image-previews-v1`,
    );
    expect(os.getEnv).not.toHaveBeenCalled();
  });

  it.each([
    ["Windows", ""],
    ["Windows", "C:relative"],
    ["Windows", "/relative-root"],
    ["Windows", "//server"],
    ["Windows", "//?/C:/safe"],
    ["Linux", ""],
    ["Linux", "relative/data"],
    ["Darwin", "~/Library"],
    ["Darwin", "/Users/safe\0bad"],
    ["Linux", "/home/safe\ninvalid"],
  ])("拒绝 %s 的无效目录 %j，不回退到应用目录", async (platform, base) => {
    vi.stubGlobal("window", { NL_OS: platform });
    vi.mocked(os.getPath).mockResolvedValue(base);
    vi.mocked(os.getEnv).mockResolvedValue(base);
    await expect(applicationDataPath("catalogs")).rejects.toThrow("无法定位");
  });

  it.each(["", ".", "..", "../other", "cache/other", "cache\\other", "bad\0name"])(
    "拒绝越界子目录 %j",
    async (part) => {
      vi.stubGlobal("window", { NL_OS: "Linux" });
      await expect(applicationCachePath(part)).rejects.toThrow("子目录无效");
      expect(os.getPath).not.toHaveBeenCalled();
    },
  );

  it("未知平台不会默认落入 Windows 分支", async () => {
    vi.stubGlobal("window", { NL_OS: "Unknown" });
    await expect(applicationDataPath()).rejects.toThrow("尚未适配");
    expect(os.getEnv).not.toHaveBeenCalled();
    expect(os.getPath).not.toHaveBeenCalled();
  });

  it("首次宿主查询失败后允许重试，不永久缓存失败", async () => {
    vi.stubGlobal("window", { NL_OS: "Linux" });
    vi.mocked(os.getPath).mockRejectedValueOnce(new Error("Safe transient failure"));
    await expect(applicationCachePath("portraits")).rejects.toThrow("Safe transient failure");
    vi.mocked(os.getPath).mockResolvedValue("/home/safe/.cache");
    expect(await applicationCachePath("portraits")).toBe("/home/safe/.cache/JAVM/portraits");
  });
});
