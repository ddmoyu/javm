import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMetadataHttp } from "../frontend/src/platform/neutralino/metadataHttp";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import { JsonHttpError } from "../frontend/src/services/metadata/shared";

const mock = vi.hoisted(() => ({
  body: "",
  status: 404,
  exitCode: 0,
  remove: vi.fn(async () => {}),
}));
vi.mock("@neutralinojs/lib", () => ({
  filesystem: {
    createDirectory: async () => {},
    remove: mock.remove,
    getStats: async () => ({ isFile: true, size: mock.body.length }),
    readFile: async () => mock.body,
  },
  os: { getPath: async () => "C:/safe/temp" },
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: async () => ({ status: mock.status, exitCode: mock.exitCode, elapsedMs: 25 }),
}));
vi.mock("../frontend/src/platform/neutralino/process", () => ({ encodedPowerShell: () => "" }));
vi.mock("../frontend/src/platform/neutralino/playbackSettings", () => ({
  playbackStorage: () => ({}),
}));
vi.mock("../frontend/src/platform/neutralino/library", () => ({ NativeLibraryPort: class {} }));
vi.mock("../frontend/src/platform/neutralino/toolPaths", () => ({ toolPlatform: () => "Windows" }));
beforeEach(() => {
  mock.status = 404;
  mock.exitCode = 0;
  mock.body = "";
  mock.remove.mockClear();
});
const request = {
  url: "http://127.0.0.1:12000/v1/movies/search?q=SAFE-001&diagnostics=1",
  metadataDiagnostics: true,
};
const http = () =>
  createMetadataHttp({ getProxy: async () => "" } as unknown as NetworkSettingsService);

describe("资料 HTTP 错误体诊断", () => {
  it("404 读取结构化诊断但不将响应正文或原始错误复制到异常", async () => {
    const diagnostics = {
      schema: 1,
      sources: [
        { provider: "Fixture", category: "incomplete", elapsedMs: 25, missingFields: ["title"] },
      ],
    };
    mock.body = JSON.stringify({
      diagnostics,
      error: "safe-private-text",
      data: { title: "safe-title" },
    });
    const error = (await http()(request, new AbortController().signal).catch(
      (value: unknown) => value,
    )) as JsonHttpError;
    expect(error).toBeInstanceOf(JsonHttpError);
    expect(error.status).toBe(404);
    expect(error.diagnostics).toEqual(diagnostics);
    expect(JSON.stringify(error)).not.toMatch(/safe-private-text|safe-title/);
    expect(mock.remove).toHaveBeenCalledOnce();
  });
  it("旧组件无效错误体保留 HTTP 状态，不伪造来源诊断", async () => {
    mock.body = "<html>Safe error</html>";
    const error = (await http()(request, new AbortController().signal).catch(
      (value: unknown) => value,
    )) as JsonHttpError;
    expect(error).toMatchObject({ status: 404 });
    expect(error.diagnostics).toBeUndefined();
  });
  it("本地传输失败标记内置服务错误，不归因为外部代理", async () => {
    mock.status = 0;
    mock.exitCode = 7;
    const error = (await http()(request, new AbortController().signal).catch(
      (value: unknown) => value,
    )) as JsonHttpError;
    expect(error.diagnostics).toMatchObject({ sources: [{ category: "service" }] });
  });
  it("成功状态的非 JSON 响应标记解析失败", async () => {
    mock.status = 200;
    mock.body = "not JSON";
    const error = (await http()(request, new AbortController().signal).catch(
      (value: unknown) => value,
    )) as JsonHttpError;
    expect(error).toMatchObject({ status: 502, diagnostics: { sources: [{ category: "parse" }] } });
  });
});
