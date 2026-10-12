import { describe, it, expect } from "vite-plus/test";
import {
  compatibleRelease,
  ApplicationUpdateService,
} from "../frontend/src/services/settings/ApplicationUpdateService";
describe("官方发布检查（安全 mock，无下载或安装）", () => {
  it("alpha 可以升级到同号正式版，正式版不会收到 alpha", () => {
    const release = {
      tag_name: "v1.0.0",
      html_url: "https://github.com/ddmoyu/javm/releases/tag/v1.0.0",
      assets: [{ name: "JAVM-1.0.0-windows-x64-offline-safe.zip" }],
    };
    expect(compatibleRelease(release, "1.0.0-alpha.1")).toMatchObject({ version: "1.0.0" });
    expect(
      compatibleRelease({ ...release, tag_name: "v1.0.1-alpha.1", prerelease: true }, "1.0.0"),
    ).toBeNull();
  });
  it("忽略旧版和预发布，仅接受当前离线包命名及官方页面", () => {
    const release = {
      tag_name: "v1.1.0",
      html_url: "https://github.com/ddmoyu/javm/releases/tag/v1.1.0",
      assets: [{ name: "JAVM-1.1.0-windows-x64-offline-20261010.zip" }],
    };
    expect(compatibleRelease(release, "1.0.0")).toMatchObject({ version: "1.1.0" });
    expect(compatibleRelease({ ...release, tag_name: "v0.5.3", assets: [] }, "1.0.0")).toBeNull();
    expect(compatibleRelease({ ...release, prerelease: true }, "1.0.0")).toBeNull();
    expect(() =>
      compatibleRelease({ ...release, assets: [{ name: "old-tauri.exe" }] }, "1.0.0"),
    ).toThrow("兼容");
    expect(() =>
      compatibleRelease({ ...release, html_url: "https://safe.invalid/release" }, "1.0.0"),
    ).toThrow("官方");
  });
  it("检查单次执行，关闭服务会取消网络请求", async () => {
    let calls = 0;
    const service = new ApplicationUpdateService(
      "1.0.0",
      async (signal) => {
        calls++;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
      true,
    );
    const check = service.check();
    await service.check();
    expect(calls).toBe(1);
    await service.shutdown();
    await check;
    expect(service.getSnapshot().busy).toBe(false);
  });
});
