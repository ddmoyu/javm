import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { events, filesystem, os } from "@neutralinojs/lib";
import {
  recoverNativeProcesses,
  runNativeProcess,
} from "../frontend/src/platform/neutralino/process";
import {
  posixProcessPayload,
  quotePosixArgument,
} from "../frontend/src/platform/neutralino/posixProcess";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

vi.mock("@neutralinojs/lib", () => ({
  events: { on: vi.fn(), off: vi.fn() },
  filesystem: {
    getStats: vi.fn(),
    access: vi.fn(),
    createDirectory: vi.fn(),
    chmod: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
  },
  os: {
    getPath: vi.fn(),
    spawnProcess: vi.fn(),
    getSpawnedProcesses: vi.fn(),
    updateSpawnedProcess: vi.fn(),
    execCommand: vi.fn(),
  },
}));
const session = new Map<string, string>();
const listeners = new Set<(event: CustomEvent) => void>();
const registry = "javm:download-processes:123";
const worker = { id: 42, pid: 4242 };
const controller = () => new AbortController();
function emit(id: number, action: "stdOut" | "stdErr" | "exit", data: string | number) {
  for (const listener of listeners) listener({ detail: { id, action, data } } as CustomEvent);
}
beforeEach(() => {
  vi.resetAllMocks();
  session.clear();
  listeners.clear();
  vi.stubGlobal("window", { NL_OS: "Linux", NL_PATH: "/Safe App/中文'路径", NL_PID: "123" });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  });
  vi.mocked(events.on).mockImplementation(async (_name, listener) => {
    listeners.add(listener);
    return { success: true, message: "" };
  });
  vi.mocked(events.off).mockImplementation(async (_name, listener) => {
    listeners.delete(listener);
    return { success: true, message: "" };
  });
  vi.mocked(filesystem.getStats).mockResolvedValue({ isFile: true } as Awaited<
    ReturnType<typeof filesystem.getStats>
  >);
  vi.mocked(os.getPath).mockResolvedValue("/tmp/safe");
  vi.mocked(os.spawnProcess).mockResolvedValue(worker);
  vi.mocked(os.getSpawnedProcesses).mockResolvedValue([worker]);
  vi.mocked(os.updateSpawnedProcess).mockResolvedValue(undefined);
  vi.mocked(filesystem.remove).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function started() {
  await vi.waitFor(() => expect(session.has(registry)).toBe(true));
}

it("参数和环境只写私有文件，命令仅含监督器路径、宿主身份和参数文件", async () => {
  const args = ["中文 空格", "$(touch /never-create)", "'\"", "safe\nline"];
  const running = runNativeProcess("/safe/curl", args, controller().signal, undefined, false, {
    TOKEN: "safe-secret",
    NO_PROXY: "",
  });
  await started();
  const command = vi.mocked(os.spawnProcess).mock.calls[0]![0];
  expect(command).toContain(
    `exec '/Safe App/中文'\\''路径/bin/javm_process' --owner 123 --payload '`,
  );
  expect(command).not.toMatch(/safe-secret|touch|powershell|taskkill/);
  const [path, body] = vi.mocked(filesystem.writeFile).mock.calls[0]!;
  expect(JSON.parse(body)).toEqual({
    schema: 1,
    file: "/safe/curl",
    args,
    envs: { TOKEN: "safe-secret", NO_PROXY: "" },
  });
  expect(filesystem.chmod).toHaveBeenNthCalledWith(1, path.slice(0, -13), 0o700);
  expect(filesystem.chmod).toHaveBeenNthCalledWith(2, path, 0o600);
  expect(vi.mocked(filesystem.chmod).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(filesystem.writeFile).mock.invocationCallOrder[0]!,
  );
  emit(worker.id, "stdOut", "安全输出\n");
  emit(worker.id, "stdErr", "safe diagnostic\n");
  emit(worker.id, "exit", 23);
  expect(await running).toEqual({
    exitCode: 23,
    stdOut: "安全输出\n",
    stdErr: "safe diagnostic\n",
  });
  expect(filesystem.remove).toHaveBeenCalledWith(path.slice(0, -13));
  expect(listeners.size).toBe(0);
  expect(JSON.parse(session.get(registry)!)).toEqual([]);
});
it("处理 spawn 返回之前的输出和退出事件", async () => {
  vi.mocked(os.spawnProcess).mockImplementation(async () => {
    emit(worker.id, "stdOut", "early");
    emit(worker.id, "exit", 0);
    return worker;
  });
  expect((await runNativeProcess("/safe/curl", [], controller().signal)).stdOut).toBe("early");
});
it("Windows 仍使用既有 PowerShell 监督器与参数格式", async () => {
  vi.stubGlobal("window", { NL_OS: "Windows", NL_PID: "123" });
  vi.mocked(os.getPath).mockResolvedValue("C:/safe-temp");
  const running = runNativeProcess("C:/safe/curl.exe", ["safe value"], controller().signal);
  await started();
  expect(vi.mocked(os.spawnProcess).mock.calls[0]![0]).toMatch(/^powershell\.exe /);
  expect(JSON.parse(vi.mocked(filesystem.writeFile).mock.calls[0]![1])).toEqual({
    file: "C:/safe/curl.exe",
    arguments: '"safe value"',
  });
  expect(filesystem.chmod).not.toHaveBeenCalled();
  emit(worker.id, "exit", 0);
  expect((await running).exitCode).toBe(0);
});
it("取消只关闭匹配监督器的 stdin，并等待官方进程清单确认", async () => {
  const abort = controller();
  const running = runNativeProcess("/safe/curl", [], abort.signal);
  await started();
  vi.mocked(os.updateSpawnedProcess).mockImplementation(async () => {
    vi.mocked(os.getSpawnedProcesses).mockResolvedValue([{ id: 43, pid: 4343 }]);
  });
  abort.abort();
  expect((await running).exitCode).toBe(-1);
  expect(os.updateSpawnedProcess).toHaveBeenCalledWith(worker.id, "stdInEnd");
  expect(os.execCommand).not.toHaveBeenCalled();
});
it("取消时 PID 已变化则不触碰其他进程且不会一直等待", async () => {
  const abort = controller();
  const running = runNativeProcess("/safe/curl", [], abort.signal);
  await started();
  vi.mocked(os.getSpawnedProcesses).mockResolvedValue([{ id: worker.id, pid: 9999 }]);
  abort.abort();
  expect((await running).exitCode).toBe(-1);
  expect(os.updateSpawnedProcess).not.toHaveBeenCalled();
});
it("重载只恢复原 id 与 pid 匹配的进程，POSIX 不调用 taskkill", async () => {
  session.set(registry, JSON.stringify([worker, { id: 99, pid: 999 }]));
  vi.mocked(os.updateSpawnedProcess).mockImplementation(async () => {
    vi.mocked(os.getSpawnedProcesses).mockResolvedValue([]);
  });
  await recoverNativeProcesses();
  expect(os.updateSpawnedProcess).toHaveBeenCalledExactlyOnceWith(worker.id, "stdInEnd");
  expect(os.execCommand).not.toHaveBeenCalled();
  expect(session.has(registry)).toBe(false);
});
it("预先取消不创建文件；权限设置失败时不写参数并清理空目录", async () => {
  const abort = controller();
  abort.abort();
  await expect(runNativeProcess("/safe/curl", [], abort.signal)).rejects.toThrow();
  expect(filesystem.createDirectory).not.toHaveBeenCalled();
  vi.mocked(filesystem.chmod).mockRejectedValue(new Error("permission fixture"));
  await expect(runNativeProcess("/safe/curl", [], controller().signal)).rejects.toThrow(
    "permission fixture",
  );
  expect(filesystem.writeFile).not.toHaveBeenCalled();
  expect(filesystem.remove).toHaveBeenCalledOnce();
  expect(os.spawnProcess).not.toHaveBeenCalled();
});
it("spawn 失败清理参数目录、监听器和并发名额", async () => {
  vi.mocked(os.spawnProcess).mockRejectedValue(new Error("spawn fixture"));
  for (let i = 0; i < 17; i++)
    await expect(runNativeProcess("/safe/curl", [], controller().signal)).rejects.toThrow(
      "spawn fixture",
    );
  expect(filesystem.remove).toHaveBeenCalledTimes(17);
  expect(listeners.size).toBe(0);
});
it("停止未确认保持可重试状态，不报告成功", async () => {
  const abort = controller();
  const running = runNativeProcess("/safe/curl", [], abort.signal);
  await started();
  const outcome = running.catch((error: unknown) => error);
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  abort.abort();
  await vi.advanceTimersByTimeAsync(5100);
  const error = await outcome;
  expect(error).toBeInstanceOf(StopUnconfirmedError);
  expect(JSON.parse(session.get(registry)!)).toHaveLength(1);
  vi.mocked(os.getSpawnedProcesses).mockResolvedValue([]);
  await (error as StopUnconfirmedError).retry();
  expect(JSON.parse(session.get(registry)!)).toHaveLength(0);
});
it("POSIX 工具并发最多 16 个，结束后释放名额", async () => {
  let id = 0;
  vi.mocked(os.spawnProcess).mockImplementation(async () => ({ id: ++id, pid: 5000 + id }));
  const runs = Array.from({ length: 16 }, () =>
    runNativeProcess("/safe/curl", [], controller().signal),
  );
  await vi.waitFor(() => expect(os.spawnProcess).toHaveBeenCalledTimes(16));
  await expect(runNativeProcess("/safe/curl", [], controller().signal)).rejects.toThrow("并发");
  for (let i = 1; i <= 16; i++) emit(i, "exit", 0);
  await Promise.all(runs);
});
it("边界校验拒绝 NUL、相对路径、环境名称注入和超长参数", () => {
  expect(quotePosixArgument("a'b")).toBe("'a'\\''b'");
  expect(() => posixProcessPayload("curl", [])).toThrow();
  expect(() => posixProcessPayload("/curl", ["a\0b"])).toThrow();
  expect(() => posixProcessPayload("/curl", [], { "BAD=KEY": "value" })).toThrow();
  expect(() => posixProcessPayload("/curl", ["中".repeat(45000)])).toThrow("过长");
});
