import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createResolutionHttp } from "../frontend/src/platform/neutralino/resolutionHttp";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";
import type { HttpRequest } from "../frontend/src/services/network/HttpService";

// 所有本地 API 与进程均被替换，不启动 curl，不创建文件，不连接任何地址。
const native = vi.hoisted(() => ({
  files: new Map<string, ArrayBuffer>(),
  run: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: native.run,
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
function output(request: HttpRequest, body: ArrayBuffer = bytes("safe")) {
  native.files.set(request.output!, body);
  return {
    exitCode: 0,
    status: 200,
    headers: { "content-type": "application/octet-stream" },
    ambiguousHeaders: false,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  native.files.clear();
  native.mkdir.mockResolvedValue(undefined);
  native.remove.mockResolvedValue(undefined);
  native.write.mockResolvedValue(undefined);
  native.read.mockImplementation(async (path: string, options: { pos: number; size: number }) =>
    native.files.get(path)!.slice(options.pos, options.pos + options.size),
  );
  native.run.mockImplementation(async (request: HttpRequest) => output(request));
});
describe("原生 HTTP 端口的 mock 验证", () => {
  it("取消句柄、字节上限、Range 和直连策略传给常驻模块；无自动跟随或重试", async () => {
    const signal = new AbortController().signal;
    await createResolutionHttp()({ ...request, range: { start: 4, length: 8 } }, signal);
    const call = native.run.mock.calls[0]!;
    expect(call[1]).toBe(signal);
    expect(call[0]).toMatchObject({
      purpose: "resolution",
      proxy: "",
      maxBytes: request.maxBytes,
      timeoutMs: request.timeoutMs,
      headers: { Range: "bytes=4-11", "Accept-Encoding": "identity" },
    });
    expect(call[0].maxRedirects).toBeUndefined();
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("拒绝有歧义的重复响应头", async () => {
    native.run.mockResolvedValue({ exitCode: 0, status: 200, ambiguousHeaders: true });
    await expect(
      createResolutionHttp()(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "parse_failed" });
    expect(native.run).toHaveBeenCalledOnce();
  });
  it(".invalid fixture 不能使用真实网络端口", async () => {
    await expect(
      createResolutionHttp()(
        { ...request, url: "https://safe.example.invalid/demo" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(native.run).not.toHaveBeenCalled();
  });
  it("按 64 KiB 分块读取，只把允许的响应头传给解析层", async () => {
    const body = new ArrayBuffer(140_000);
    native.run.mockImplementation(async (request: HttpRequest) => ({
      ...output(request, body),
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    }));
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
    native.run.mockResolvedValue({ exitCode, status: 0 });
    await expect(
      createResolutionHttp()(request, new AbortController().signal),
    ).rejects.toMatchObject({ code });
    expect(native.remove).toHaveBeenCalledOnce();
  });
  it("原生停止未确认时保留目录，重试确认后才删除", async () => {
    const retry = vi.fn(async () => {});
    native.run.mockRejectedValue(new StopUnconfirmedError(retry));
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
    native.run.mockImplementation(async (request: HttpRequest) => {
      const result = output(request);
      abort.abort(new ResolutionError("cancelled"));
      return result;
    });
    await expect(createResolutionHttp()(request, abort.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(native.read).not.toHaveBeenCalled();
    expect(native.remove).toHaveBeenCalledOnce();
  });
});
