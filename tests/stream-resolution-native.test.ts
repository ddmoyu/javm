import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createResolutionHttp } from "../frontend/src/platform/neutralino/resolutionHttp";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";

// 所有本地 API 与进程均被替换，不启动 curl，不创建文件，不连接任何地址。
const native = vi.hoisted(() => ({
  files: new Map<string, ArrayBuffer>(),
  find: vi.fn(),
  run: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("../frontend/src/platform/neutralino/process", () => ({
  findOnPath: native.find,
  runNativeProcess: native.run,
}));
vi.mock("@neutralinojs/lib", () => ({
  os: { getPath: vi.fn(async () => "C:/mock-temp") },
  filesystem: {
    createDirectory: native.mkdir,
    remove: native.remove,
    writeFile: native.write,
    readBinaryFile: native.read,
    getStats: vi.fn(async (path: string) => {
      const value = native.files.get(path);
      if (!value) throw new Error("未找到 mock 文件");
      return { isFile: true, size: value.byteLength };
    }),
  },
}));
const bytes = (value: string) => new TextEncoder().encode(value).buffer;
const request = {
  url: "https://media.example/DEMO-001",
  headers: {},
  maxBytes: 256 * 1024,
  timeoutMs: 10_000,
  proxy: "",
};
function output(
  args: string[],
  body: ArrayBuffer = bytes("safe"),
  headers = "HTTP/2 200\r\nContent-Type: application/octet-stream\r\n\r\n",
) {
  native.files.set(args[args.indexOf("--output") + 1]!, body);
  native.files.set(args[args.indexOf("--dump-header") + 1]!, bytes(headers));
}
beforeEach(() => {
  vi.resetAllMocks();
  native.files.clear();
  native.find.mockResolvedValue("C:/mock/curl.exe");
  native.mkdir.mockResolvedValue(undefined);
  native.remove.mockResolvedValue(undefined);
  native.write.mockResolvedValue(undefined);
  native.read.mockImplementation(async (path: string, options: { pos: number; size: number }) =>
    native.files.get(path)!.slice(options.pos, options.pos + options.size),
  );
  native.run.mockImplementation(async (_file: string, args: string[]) => {
    if (args.includes("--version")) return { exitCode: 0, stdOut: "curl 8.22.0 mock", stdErr: "" };
    output(args);
    return { exitCode: 0, stdOut: "200", stdErr: "" };
  });
});
describe("原生 HTTP 端口的 mock 验证", () => {
  it("取消句柄、字节上限、Range 和直连策略传给受管进程；无自动跟随或重试", async () => {
    const signal = new AbortController().signal;
    await createResolutionHttp()({ ...request, range: { start: 4, length: 8 } }, signal);
    const call = native.run.mock.calls[1]!;
    expect(call[2]).toBe(signal);
    expect(call[4]).toBe(true);
    const args = call[1] as string[];
    for (const arg of [
      "--disable",
      "--globoff",
      "--max-filesize",
      "--max-time",
      "--connect-timeout",
      "--proto",
      "--range",
    ])
      expect(args).toContain(arg);
    expect(args[args.indexOf("--range") + 1]).toBe("4-11");
    expect(args[args.indexOf("--noproxy") + 1]).toBe("*");
    expect(args).not.toContain("--location");
    expect(args).not.toContain("--retry");
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("拒绝旧 curl，避免未知长度响应绕过文件大小限制", async () => {
    native.run.mockResolvedValue({ exitCode: 0, stdOut: "curl 8.3.0 mock", stdErr: "" });
    await expect(
      createResolutionHttp()(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(native.mkdir).not.toHaveBeenCalled();
    expect(native.run).toHaveBeenCalledOnce();
  });
  it(".invalid fixture 不能使用真实网络端口", async () => {
    await expect(
      createResolutionHttp()(
        { ...request, url: "https://safe.example.invalid/demo" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(native.find).not.toHaveBeenCalled();
  });
  it("按 64 KiB 分块读取，忽略代理 CONNECT 头与 Set-Cookie", async () => {
    const body = new ArrayBuffer(140_000);
    native.run.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes("--version")) return { exitCode: 0, stdOut: "curl 8.4.0 mock", stdErr: "" };
      output(
        args,
        body,
        "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nContent-Type: application/octet-stream\r\nSet-Cookie: private=mock\r\n\r\n",
      );
      return { exitCode: 0, stdOut: "200", stdErr: "" };
    });
    const value = await createResolutionHttp()(request, new AbortController().signal);
    expect(value.body.byteLength).toBe(140_000);
    expect(value.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(
      native.read.mock.calls.every((call) => (call[1] as { size: number }).size <= 65_536),
    ).toBe(true);
  });
  it.each([
    [63, "limit_exceeded"],
    [28, "timeout"],
    [7, "network_error"],
  ])("curl %s 只返回脱敏失败", async (exitCode, code) => {
    native.run.mockImplementation(async (_file: string, args: string[]) =>
      args.includes("--version")
        ? { exitCode: 0, stdOut: "curl 8.22.0 mock", stdErr: "" }
        : { exitCode, stdOut: "", stdErr: "private-token=never-log" },
    );
    await expect(
      createResolutionHttp()(request, new AbortController().signal),
    ).rejects.toMatchObject({ code });
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("原生停止未确认时保留目录，重试确认后才删除", async () => {
    const retry = vi.fn(async () => {});
    native.run.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes("--version"))
        return { exitCode: 0, stdOut: "curl 8.22.0 mock", stdErr: "" };
      throw new StopUnconfirmedError(retry);
    });
    let pending: unknown;
    try {
      await createResolutionHttp()(request, new AbortController().signal);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(StopUnconfirmedError);
    expect(native.remove).not.toHaveBeenCalled();
    await (pending as StopUnconfirmedError).retry();
    expect(retry).toHaveBeenCalledOnce();
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("删除失败保留可重试清理句柄", async () => {
    native.remove.mockRejectedValueOnce(new Error("mock locked"));
    let pending: unknown;
    try {
      await createResolutionHttp()(request, new AbortController().signal);
    } catch (error) {
      pending = error;
    }
    expect(pending).toBeInstanceOf(StopUnconfirmedError);
    await (pending as StopUnconfirmedError).retry();
    expect(native.remove).toHaveBeenCalledTimes(2);
  });
  it("取消发生在读取前时清理目录，不返回已取消结果", async () => {
    const abort = new AbortController();
    native.run.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes("--version"))
        return { exitCode: 0, stdOut: "curl 8.22.0 mock", stdErr: "" };
      output(args);
      abort.abort(new ResolutionError("cancelled"));
      return { exitCode: 0, stdOut: "200", stdErr: "" };
    });
    await expect(createResolutionHttp()(request, abort.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(native.read).not.toHaveBeenCalled();
    expect(native.remove).toHaveBeenCalledOnce();
  });
});
