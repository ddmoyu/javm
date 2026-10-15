import { beforeEach, expect, it, vi } from "vite-plus/test";
import { storage } from "@neutralinojs/lib";
vi.mock("@neutralinojs/lib", () => ({
  app: { exit: vi.fn() },
  filesystem: { writeFile: vi.fn() },
  storage: { getKeys: vi.fn(), getData: vi.fn() },
}));
vi.mock("../frontend/src/platform/neutralino/library", () => ({
  NativeLibraryPort: class {
    request = async (method: string) =>
      method === "update.configure"
        ? { kind: "portable" }
        : method === "update.trial"
          ? { trial: true }
          : method === "update.status"
            ? { phase: "committed" }
            : {};
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {
    NL_PATH: "E:/safe-fixtures",
    NL_DATAPATH: "E:/safe-fixtures",
    NL_PID: 1,
  });
  vi.mocked(storage.getKeys).mockResolvedValue(["failure-feedback-v1", "safe-settings"]);
});
it("旧诊断 JSON 损坏不阻断更新健康验证，业务设置仍需要有效 JSON", async () => {
  try {
    vi.mocked(storage.getData).mockImplementation(async (key) =>
      key === "failure-feedback-v1" ? '{"interrupted"' : '{"safe":true}',
    );
    const updater = await import("../frontend/src/platform/neutralino/updateStartup");
    await updater.prepareUpdateStartup();
    await updater.confirmUpdateStartup();
    expect(storage.getData).not.toHaveBeenCalledWith("failure-feedback-v1");
    expect(storage.getData).toHaveBeenCalledWith("safe-settings");
    vi.resetModules();
    vi.mocked(storage.getData).mockResolvedValue('{"invalid"');
    const broken = await import("../frontend/src/platform/neutralino/updateStartup");
    await broken.prepareUpdateStartup();
    await expect(broken.confirmUpdateStartup()).rejects.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
