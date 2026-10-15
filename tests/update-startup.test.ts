import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({
  request: vi.fn(),
  exit: vi.fn(),
  getKeys: vi.fn(),
  getData: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  app: { exit: mock.exit },
  storage: { getKeys: mock.getKeys, getData: mock.getData },
  filesystem: { writeFile: mock.writeFile },
}));
vi.mock("../frontend/src/platform/neutralino/library", () => ({
  NativeLibraryPort: class {
    request = mock.request;
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { NL_PATH: "/safe/app", NL_DATAPATH: "/safe/settings", NL_PID: 42 });
  mock.exit.mockResolvedValue(undefined);
  mock.getKeys.mockResolvedValue(["safe-preferences"]);
  mock.getData.mockResolvedValue('{"safe":true}');
  mock.writeFile.mockResolvedValue(undefined);
  mock.request.mockImplementation(async (method: string) => {
    if (method === "update.configure") return { available: true, kind: "portable" };
    if (method === "update.trial") return { trial: true };
    if (method === "update.status") return { phase: "committed" };
    return {};
  });
});
afterEach(() => vi.unstubAllGlobals());

async function isHeld() {
  const { waitForUpdateStartup } = await import("../frontend/src/platform/neutralino/updateGate");
  let released = false;
  void waitForUpdateStartup().then(() => {
    released = true;
  });
  await Promise.resolve();
  return !released;
}
describe("更新试运行的业务启动门闩", () => {
  it("实际挂载后的健康确认仅执行一次，提交成功才放行业务", async () => {
    const service = await import("../frontend/src/platform/neutralino/updateStartup");
    await service.prepareUpdateStartup();
    expect(await isHeld()).toBe(true);
    const first = service.confirmUpdateStartup();
    expect(service.confirmUpdateStartup()).toBe(first);
    await first;
    const { waitForUpdateStartup } = await import("../frontend/src/platform/neutralino/updateGate");
    await waitForUpdateStartup();
    expect(await isHeld()).toBe(false);
    expect(mock.request.mock.calls.map(([method]) => method)).toEqual([
      "update.configure",
      "update.trial",
      "hello",
      "library.status",
      "update.healthy",
      "update.status",
    ]);
    expect(mock.getData).toHaveBeenCalledWith("safe-preferences");
  });
  it("数据库健康探测失败不确认新版、不开放业务", async () => {
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation(async (method: string) => {
      if (method === "library.status") throw new Error("safe fixture database failure");
      return original(method);
    });
    const service = await import("../frontend/src/platform/neutralino/updateStartup");
    await service.prepareUpdateStartup();
    await expect(service.confirmUpdateStartup()).rejects.toThrow("safe fixture database failure");
    expect(mock.request.mock.calls.some(([method]) => method === "update.healthy")).toBe(false);
    expect(await isHeld()).toBe(true);
  });
  it("设置损坏不确认新版，不覆盖原设置", async () => {
    mock.getData.mockResolvedValue("invalid-safe-json");
    const service = await import("../frontend/src/platform/neutralino/updateStartup");
    await service.prepareUpdateStartup();
    await expect(service.confirmUpdateStartup()).rejects.toThrow();
    expect(mock.request.mock.calls.some(([method]) => method === "update.healthy")).toBe(false);
    expect(mock.writeFile).not.toHaveBeenCalled();
    expect(await isHeld()).toBe(true);
  });
  it("恢复中退出当前进程，由安装助手完成回退", async () => {
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation(async (method: string) =>
      method === "update.trial" ? { trial: false, recovering: true } : original(method),
    );
    const service = await import("../frontend/src/platform/neutralino/updateStartup");
    expect(await service.prepareUpdateStartup()).toBe(false);
    expect(mock.exit).toHaveBeenCalledTimes(1);
  });
  it("退出中断通过官方文件 API 取消安装等待，不依赖已关闭的扩展", async () => {
    const service = await import("../frontend/src/platform/neutralino/updateStartup");
    await service.cancelUpdateHandoff("/safe/transaction/exit-ready.json");
    expect(mock.writeFile).toHaveBeenCalledWith(
      "/safe/transaction/exit-cancelled.json",
      '{"cancelled":true}',
    );
    expect(mock.request).not.toHaveBeenCalled();
    await expect(service.cancelUpdateHandoff("/safe/other.json")).rejects.toThrow();
  });
});
