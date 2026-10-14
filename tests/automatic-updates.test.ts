import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { acceptsVersion, compareVersions } from "../frontend/src/services/settings/updateVersions";
import { updateReleases } from "../frontend/src/services/settings/updateDiscovery";
import {
  UpdateService,
  UpdateRestartRequiredError,
  type UpdatePort,
} from "../frontend/src/services/settings/UpdateService";
import type { NativeUpdateStatus, UpdateCandidate } from "../frontend/src/contracts/updates";

const candidate: UpdateCandidate = {
  version: "1.2.0-beta.10",
  url: "https://github.com/ddmoyu/javm/releases/tag/v1.2.0-beta.10",
  notes: "安全测试更新",
  envelope: { payload: "", signature: "" },
  asset: {
    platform: "windows-x64",
    kind: "portable",
    name: "JAVM-fixture.jup",
    bytes: 100,
    sha256: "a".repeat(64),
  },
};
function fixture(initial: NativeUpdateStatus = { phase: "idle" }) {
  let status = initial;
  const port: UpdatePort = {
    installation: async () => ({
      available: true,
      kind: "portable",
      failedVersion: candidate.version,
    }),
    find: vi.fn(async () => candidate),
    status: async () => status,
    download: vi.fn(async (_candidate, _signal, progress) => {
      status = { phase: "ready", version: candidate.version };
      progress(status);
    }),
    install: vi.fn(async () => {}),
    cancel: vi.fn(async () => {
      status = { phase: "cancelled" };
    }),
  };
  const service = new UpdateService("1.2.0-beta.2", port, {
    read: async () => ({ channel: "beta", automatic: false, lastCheck: 0 }),
    write: vi.fn(async () => {}),
  });
  return { service, port };
}
afterEach(() => vi.useRealTimers());
describe("双通道自动更新", () => {
  it("按数值比较 Beta，正式版本高于同版 Beta，忽略 Alpha", () => {
    expect(compareVersions("1.2.0-beta.10", "1.2.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.0-beta.99")).toBeGreaterThan(0);
    expect(compareVersions("1.1.9", "1.2.0-beta.1")).toBeLessThan(0);
    expect(acceptsVersion("9.0.0-alpha.1", "beta")).toBe(false);
    expect(acceptsVersion("2.0.0-beta.1", "stable")).toBe(false);
  });
  it("过滤组件、草稿、Alpha、通道标识错误和没有更新清单的发布", () => {
    const release = (version: string, prerelease = false) => ({
      tag_name: "v" + version,
      prerelease,
      assets: [{ name: "JAVM-update.json" }],
    });
    const input = [
      release("1.2.0-beta.10", true),
      release("1.2.0"),
      release("1.2.0-alpha.99", true),
      release("2.0.0", true),
      release("deps-curl-1"),
      { ...release("3.0.0"), draft: true },
      { ...release("4.0.0"), assets: [] },
    ];
    expect(updateReleases(input, "1.2.0-beta.2", "beta").map((item) => item.version)).toEqual([
      "1.2.0",
      "1.2.0-beta.10",
    ]);
    expect(updateReleases(input, "1.2.0-beta.2", "stable").map((item) => item.version)).toEqual([
      "1.2.0",
    ]);
    expect(updateReleases(input, "1.3.0-beta.1", "stable")).toEqual([]);
  });
  it("自动检查不重复推荐失败版本，手动检查允许重试", async () => {
    const { service } = fixture();
    await service.check(false);
    expect(service.getSnapshot().release).toBeNull();
    await service.check(true);
    expect(service.getSnapshot().release?.version).toBe(candidate.version);
    await service.shutdown();
  });
  it("检查不会下载或安装，下载完成仍需明确安装", async () => {
    const { service, port } = fixture();
    await service.check();
    expect(port.download).not.toHaveBeenCalled();
    expect(port.install).not.toHaveBeenCalled();
    await service.download();
    expect(service.getSnapshot().status.phase).toBe("ready");
    expect(port.install).not.toHaveBeenCalled();
    await service.install();
    expect(port.install).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });
  it("就绪时关闭自动检查仍保留已下载版本，换通道才取消", async () => {
    const { service, port } = fixture({ phase: "ready", version: candidate.version });
    await service.initialize();
    await service.configure("beta", false);
    expect(service.getSnapshot().status.phase).toBe("ready");
    await service.configure("stable", false);
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().status.phase).toBe("idle");
    await service.shutdown();
  });
  it("安装助手启动失败后保留重试入口", async () => {
    const { service, port } = fixture({ phase: "ready", version: candidate.version });
    port.install = async () => {
      throw new Error("安装助手启动失败");
    };
    await service.initialize();
    await service.install();
    expect(service.getSnapshot().status.phase).toBe("ready");
    expect(service.getSnapshot().error).toBe("安装助手启动失败");
    await service.shutdown();
  });
  it("服务收尾失败后提示重新打开应用，防止在已关闭服务上继续安装", async () => {
    const { service, port } = fixture({ phase: "ready", version: candidate.version });
    port.install = vi.fn(async () => {
      throw new UpdateRestartRequiredError("请重新打开应用后继续安装");
    });
    await service.initialize();
    await service.install();
    await service.install();
    expect(port.install).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().restartRequired).toBe(true);
    await service.shutdown();
  });
  it("取消下载等待后台停止，重复点击不会启动两个下载", async () => {
    const { service, port } = fixture();
    port.download = vi.fn(
      (_candidate, signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        ),
    );
    await service.check();
    const download = service.download();
    await service.download();
    await service.cancel();
    await download;
    expect(port.download).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().status.phase).toBe("cancelled");
    await service.shutdown();
  });
});
