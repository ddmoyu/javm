import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { filesystem, os } from "@neutralinojs/lib";
import { findOnPath } from "../frontend/src/platform/neutralino/process";
import { nativeDownloadHost } from "../frontend/src/platform/neutralino/downloadHost";
import {
  applicationToolPath,
  applicationResourcePath,
  toolExecutableName,
} from "../frontend/src/platform/neutralino/toolPaths";

vi.mock("@neutralinojs/lib", () => ({
  filesystem: { getStats: vi.fn(), access: vi.fn() },
  os: { getEnv: vi.fn(), execCommand: vi.fn() },
}));
const files = new Set<string>();
const missing = { code: "NE_FS_NOPATHE" };
beforeEach(() => {
  vi.resetAllMocks();
  files.clear();
  vi.stubGlobal("window", { NL_OS: "Linux", NL_PATH: "/safe/应用 空格" });
  vi.mocked(filesystem.getStats).mockImplementation(async (path) => {
    if (!files.has(path)) throw missing;
    return { isFile: true } as Awaited<ReturnType<typeof filesystem.getStats>>;
  });
  vi.mocked(filesystem.access).mockResolvedValue("");
  vi.mocked(os.getEnv).mockResolvedValue(":.:relative:/usr/local/bin:/usr/bin");
});
afterEach(() => vi.unstubAllGlobals());

it("macOS APP 从 Resources 读取版本记录，程序仍位于 MacOS", () => {
  vi.stubGlobal("window", { NL_OS: "Darwin", NL_PATH: "/安全 ' 包/JAVM.app/Contents/MacOS" });
  expect(applicationResourcePath("tools", "metatube", "installed.json")).toBe(
    "/安全 ' 包/JAVM.app/Contents/Resources/tools/metatube/installed.json",
  );
  expect(applicationToolPath("tools", "metatube", "metatube-server")).toBe(
    "/安全 ' 包/JAVM.app/Contents/MacOS/bin/tools/metatube/metatube-server",
  );
  vi.stubGlobal("window", { NL_OS: "Darwin", NL_PATH: "/安全 开发目录" });
  expect(applicationResourcePath("tools", "metatube", "installed.json")).toBe(
    "/安全 开发目录/bin/tools/metatube/installed.json",
  );
});

it.each(["Linux", "Darwin"])("%s 使用无后缀工具并优先内置路径", async (platform) => {
  vi.stubGlobal("window", { NL_OS: platform, NL_PATH: "/safe/应用 空格" });
  expect(toolExecutableName("curl")).toBe("curl");
  expect(toolExecutableName("metatube-server")).toBe("metatube-server");
  const bundled = "/safe/应用 空格/bin/tools/ffmpeg";
  files.add(bundled);
  expect(await nativeDownloadHost.tool("ffmpeg", "")).toBe(bundled);
  expect(filesystem.access).toHaveBeenCalledWith(bundled, 1);
  expect(os.getEnv).not.toHaveBeenCalled();
  expect(os.execCommand).not.toHaveBeenCalled();
});
it("Windows 保留内置 exe 查找且不执行 POSIX 权限检查", async () => {
  vi.stubGlobal("window", { NL_OS: "Windows", NL_PATH: "C:\\Safe App" });
  files.add("C:/Safe App/bin/tools/curl.exe");
  expect(await nativeDownloadHost.tool("curl", "")).toBe("C:/Safe App/bin/tools/curl.exe");
  expect(filesystem.access).not.toHaveBeenCalled();
});
it("PATH 忽略当前目录，跳过无执行权限项，保留大小写和符号字符", async () => {
  const target = "/Safe Tools/$literal'中/curl";
  vi.mocked(os.getEnv).mockResolvedValue(`:.:relative:/denied:${target.slice(0, -5)}`);
  files.add("/denied/curl");
  files.add(target);
  vi.mocked(filesystem.access).mockImplementation(async (path) => {
    if (path === "/denied/curl") throw { code: "NE_FS_ACSFAIL" };
    return "";
  });
  expect(await findOnPath("curl")).toBe(target);
  expect(vi.mocked(filesystem.getStats).mock.calls.flat()).not.toContain("./curl");
  expect(os.execCommand).not.toHaveBeenCalled();
});
it("显式工具不存在或不可执行时不静默回退 PATH", async () => {
  await expect(nativeDownloadHost.tool("curl", "/missing/curl")).rejects.toThrow("缺失");
  files.add("/configured/curl");
  vi.mocked(filesystem.access).mockRejectedValue({ code: "NE_FS_ACSFAIL" });
  await expect(nativeDownloadHost.tool("curl", "/configured/curl")).rejects.toThrow("执行权限");
  expect(os.getEnv).not.toHaveBeenCalled();
});
it("内置包执行权限丢失时报错，不借用 PATH 程序掩盖打包问题", async () => {
  files.add("/safe/应用 空格/bin/tools/curl");
  vi.mocked(filesystem.access).mockRejectedValue({ code: "NE_FS_ACSFAIL" });
  await expect(findOnPath("curl")).rejects.toThrow("执行权限");
  expect(os.getEnv).not.toHaveBeenCalled();
});
it("POSIX 路径中的反斜线保留原义，拒绝相对配置和工具名称注入", async () => {
  vi.stubGlobal("window", { NL_OS: "Linux", NL_PATH: "/safe/literal\\" });
  expect(applicationToolPath("tools", "curl")).toBe("/safe/literal\\/bin/tools/curl");
  await expect(nativeDownloadHost.tool("curl", "relative/curl")).rejects.toThrow("绝对路径");
  await expect(findOnPath("curl; touch marker")).rejects.toThrow("名称");
  expect(filesystem.getStats).not.toHaveBeenCalled();
});
it("未知系统和过多 PATH 目录明确失败", async () => {
  vi.mocked(os.getEnv).mockResolvedValue(
    Array.from({ length: 257 }, (_, i) => `/dir${i}`).join(":"),
  );
  await expect(findOnPath("curl")).rejects.toThrow("目录过多");
  vi.stubGlobal("window", { NL_OS: "Unknown", NL_PATH: "/safe" });
  expect(() => toolExecutableName("curl")).toThrow("尚未适配");
});
