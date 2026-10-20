import { describe, expect, it } from "vite-plus/test";
import {
  compatibleRelease,
  newerVersion,
  releasePlatform,
} from "../frontend/src/services/settings/ApplicationUpdateService";

const release = (name: string) => ({
  tag_name: "v1.0.6",
  html_url: "https://github.com/ddmoyu/javm/releases/tag/v1.0.6",
  assets: [{ name }],
});
describe("跨平台更新识别", () => {
  it("只接受当前系统架构，不误选其他平台的包", () => {
    for (const [platform, extension] of [
      ["windows-x64", "-setup.exe"],
      ["macos-x64", ".dmg"],
      ["macos-arm64", "-portable.zip"],
      ["linux-x64", ".AppImage"],
    ] as const) {
      expect(
        compatibleRelease(release(`JAVM-1.0.6-${platform}${extension}`), "1.0.5", platform)
          ?.version,
      ).toBe("1.0.6");
      expect(() => compatibleRelease(release("JAVM-1.0.6-unknown.zip"), "1.0.5", platform)).toThrow(
        "兼容",
      );
    }
  });
  it("正式版本可以升级同版本 Alpha，较旧补丁不会误报", () => {
    expect(newerVersion("1.0.5", "1.0.5-alpha.9")).toBe(true);
    expect(newerVersion("1.0.4", "1.0.5-alpha.9")).toBe(false);
    expect(newerVersion("1.0.5", "1.0.5")).toBe(false);
  });
  it("映射 Neutralino 的 arm，但不宣称 Linux 或 Windows ARM64 已支持", () => {
    expect(releasePlatform("Darwin", "arm")).toBe("macos-arm64");
    expect(releasePlatform("Darwin", "x64")).toBe("macos-x64");
    expect(releasePlatform("Linux", "arm")).toBeUndefined();
    expect(releasePlatform("Windows", "arm64")).toBeUndefined();
  });
});
