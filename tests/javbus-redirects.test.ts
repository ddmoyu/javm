import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  isJavbusFetchUrl,
  JavbusRedirectError,
  requestJavbusWithRedirects,
} from "../frontend/src/services/catalog/javbusRedirects";
import type { JavbusRedirectDiagnostic } from "../frontend/src/services/catalog/javbusRedirects";
import { parseJavbusWorks } from "../frontend/src/services/catalog/javbusWorks";
import type { HttpRequest, HttpResponse } from "../frontend/src/services/network/HttpService";

// 请求执行器全为 mock；任何测试网址均不会发起真实网络请求。
const origin = "https://www.javbus.com";
const url = `${origin}/star/safe`;
const request: HttpRequest = {
  purpose: "catalog",
  url,
  output: "safe-response",
  timeoutMs: 25000,
  maxBytes: 1024,
  proxy: "http://127.0.0.1:1234",
  headers: { Referer: `${origin}/` },
};
function response(input: HttpRequest, patch: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    exitCode: 0,
    bytes: 10,
    headers: {},
    effectiveUrl: input.url,
    elapsedMs: 1,
    connections: 0,
    tunnelStatus: 0,
    setCookie: false,
    ambiguousHeaders: false,
    ...patch,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("JavBus 受控重定向", () => {
  it.each([301, 302, 303, 307, 308])(
    "HTTP %i 站内相对 Location 可继续，始终禁止原生自动跟随",
    async (status) => {
      const execute = vi.fn(async (input: HttpRequest) =>
        response(input, input.url === url ? { status, headers: { location: "safe/" } } : {}),
      );
      const report = vi.fn();
      const result = await requestJavbusWithRedirects(
        request,
        new AbortController().signal,
        execute,
        report,
      );
      expect(result.status).toBe(200);
      expect(execute.mock.calls.map(([input]) => input.url)).toEqual([url, `${url}/`]);
      expect(
        execute.mock.calls.every(
          ([input]) =>
            input.maxRedirects === 0 &&
            input.proxy === request.proxy &&
            input.output === request.output,
        ),
      ).toBe(true);
      expect(report).toHaveBeenCalledWith({
        status,
        hop: 1,
        reason: "follow",
        upgradedHttps: false,
      });
    },
  );
  it("站点返回同站 HTTP Location 时只请求 HTTPS 等价地址", async () => {
    const initial = `${origin}/genre/`;
    const execute = vi.fn(async (input: HttpRequest) =>
      response(
        input,
        input.url === initial
          ? { status: 301, headers: { location: "http://www.javbus.com/genre" } }
          : {},
      ),
    );
    const report = vi.fn();
    const result = await requestJavbusWithRedirects(
      { ...request, url: initial },
      new AbortController().signal,
      execute,
      report,
    );
    expect(result.status).toBe(200);
    expect(execute.mock.calls.map(([input]) => input.url)).toEqual([initial, `${origin}/genre`]);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ upgradedHttps: true }));
  });
  it("裸域名与 www 规范化可继续，跨主机不转发 Cookie 和 Authorization", async () => {
    const initial = "https://javbus.com/star/safe";
    const execute = vi.fn(async (input: HttpRequest) =>
      response(input, input.url === initial ? { status: 302, headers: { location: url } } : {}),
    );
    await requestJavbusWithRedirects(
      {
        ...request,
        url: initial,
        headers: { Cookie: "safe=mock", Authorization: "safe-token", Accept: "text/html" },
      },
      new AbortController().signal,
      execute,
    );
    expect(execute.mock.calls[1]![0].headers).toEqual({ Accept: "text/html" });
    expect(execute.mock.calls[1]![0].url).toBe(url);
  });
  it("允许首页和第一页规范化，保留数字来源 ID，百分号编码不改变搜索词", async () => {
    for (const [from, to] of [
      ["/star/123/1", "/star/123"],
      ["/actresses/1", "/actresses"],
      ["/page/1", "/"],
      ["/searchstar/%E7%A4%BA%E4%BE%8B", "/searchstar/%e7%a4%ba%e4%be%8b/"],
    ] as const) {
      const execute = vi.fn(async (input: HttpRequest) =>
        response(
          input,
          input.url === `${origin}${from}` ? { status: 302, headers: { location: to } } : {},
        ),
      );
      expect(
        (
          await requestJavbusWithRedirects(
            { ...request, url: `${origin}${from}` },
            new AbortController().signal,
            execute,
          )
        ).status,
      ).toBe(200);
    }
  });
  it.each([
    ["https://safe.invalid/star/safe", "untrusted_target"],
    ["https://www.javbus.com.safe.invalid/star/safe", "untrusted_target"],
    ["https://user@www.javbus.com/star/safe", "untrusted_target"],
    ["https://www.javbus.com:8443/star/safe", "untrusted_target"],
    ["file:///safe", "untrusted_target"],
    ["/agecheck?return=safe", "verification"],
    ["/age-verification", "verification"],
    ["/login", "verification"],
    ["/cdn-cgi/challenge-platform/example", "verification"],
    ["/ajax/uncledatoolsbyajax.php", "unsupported_path"],
    ["/star/safe?unknown=1", "unsupported_path"],
    ["/star/other", "identity_changed"],
    ["/star/safe/2", "identity_changed"],
    ["/uncensored/star/safe", "identity_changed"],
    ["/genre/safe", "identity_changed"],
    ["/star/safe%2Fother", "invalid_location"],
    ["/star/safe\r\nUnsafe: value", "invalid_location"],
  ])("拒绝不符合身份或来源约束的跳转 %s", async (location, reason) => {
    const execute = vi.fn(async (input: HttpRequest) =>
      response(input, { status: 302, headers: { location } }),
    );
    const report = vi.fn();
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, execute, report),
    ).rejects.toMatchObject({
      name: "JavbusRedirectError",
      diagnostic: expect.objectContaining({ reason, status: 302 }),
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(report.mock.calls)).not.toContain(location);
  });
  it("重复或缺失 Location 不会请求不确定地址", async () => {
    const patches: Partial<HttpResponse>[] = [
      { headers: {} },
      { headers: { location: "/star/safe/, /star/safe" }, ambiguousHeaders: true },
    ];
    for (const patch of patches) {
      const execute = vi.fn(async (input: HttpRequest) =>
        response(input, { status: 302, ...patch }),
      );
      await expect(
        requestJavbusWithRedirects(request, new AbortController().signal, execute),
      ).rejects.toBeInstanceOf(JavbusRedirectError);
      expect(execute).toHaveBeenCalledOnce();
    }
  });
  it("循环立即退出，最长三次跳转后仍可接收成功响应", async () => {
    const loop = vi.fn(async (input: HttpRequest) =>
      response(input, { status: 302, headers: { location: input.url === url ? `${url}/` : url } }),
    );
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, loop),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ reason: "loop" }) });
    expect(loop).toHaveBeenCalledTimes(2);
    const chain = [`${url}/`, `${url}/1`, `${url}/1/`];
    const success = vi.fn(async (input: HttpRequest) =>
      response(
        input,
        success.mock.calls.length <= 3
          ? { status: 302, headers: { location: chain[success.mock.calls.length - 1]! } }
          : {},
      ),
    );
    expect(
      (await requestJavbusWithRedirects(request, new AbortController().signal, success)).status,
    ).toBe(200);
    expect(success).toHaveBeenCalledTimes(4);
    const excessive = vi.fn(async (input: HttpRequest) =>
      response(input, {
        status: 302,
        headers: {
          location: [...chain, "https://javbus.com/star/safe"][excessive.mock.calls.length - 1]!,
        },
      }),
    );
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, excessive),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ reason: "limit" }) });
    expect(excessive).toHaveBeenCalledTimes(4);
  });
  it("所有跳转共用超时和响应总量，取消后不发下一跳", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const execute = vi.fn(async (input: HttpRequest) => {
      now += 500;
      return response(
        input,
        input.url === url ? { status: 302, bytes: 40, headers: { location: `${url}/` } } : {},
      );
    });
    await requestJavbusWithRedirects(request, new AbortController().signal, execute);
    expect(execute.mock.calls[1]![0]).toMatchObject({ timeoutMs: 24500, maxBytes: 984 });
    const slow = vi.fn(async (input: HttpRequest) => {
      now += 26000;
      return response(input, { status: 302, headers: { location: `${url}/` } });
    });
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, slow),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ reason: "timeout" }) });
    const large = vi.fn(async (input: HttpRequest) =>
      response(input, { status: 302, bytes: 1024, headers: { location: `${url}/` } }),
    );
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, large),
    ).rejects.toMatchObject({ diagnostic: expect.objectContaining({ reason: "size_limit" }) });
    const abort = new AbortController();
    const canceled = vi.fn(async (input: HttpRequest) => {
      abort.abort(new Error("安全 mock 取消"));
      return response(input, { status: 302, headers: { location: `${url}/` } });
    });
    await expect(requestJavbusWithRedirects(request, abort.signal, canceled)).rejects.toThrow(
      "安全 mock 取消",
    );
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("200 直返、403 与 TLS 失败不重试，意外自动跳转不能作为成功内容", async () => {
    for (const patch of [{ status: 200 }, { status: 403 }, { status: 0, exitCode: 35 }]) {
      const execute = vi.fn(async (input: HttpRequest) => response(input, patch));
      await expect(
        requestJavbusWithRedirects(request, new AbortController().signal, execute),
      ).resolves.toMatchObject(patch);
      expect(execute).toHaveBeenCalledOnce();
    }
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, async (input) =>
        response(input, { effectiveUrl: `${origin}/star/other` }),
      ),
    ).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ reason: "unexpected_final" }),
    });
  });
  it("脱敏日志只含固定原因及数值，不包含演员、网址、Header 或 Cookie", async () => {
    const reports: JavbusRedirectDiagnostic[] = [];
    const execute = vi.fn(async (input: HttpRequest) =>
      response(input, {
        status: 302,
        headers: { location: "/login?private=safe-mock", "set-cookie": "safe=mock" },
      }),
    );
    await expect(
      requestJavbusWithRedirects(request, new AbortController().signal, execute, (value) =>
        reports.push(value),
      ),
    ).rejects.toThrow("验证或登录");
    expect(reports).toEqual([
      { status: 302, hop: 0, reason: "verification", upgradedHttps: false },
    ]);
  });
  it("结果中的已确认域名和斜杠别名仍解析为规范作品地址", () => {
    expect(isJavbusFetchUrl("https://javbus.com/genre/")).toBe(true);
    expect(isJavbusFetchUrl("http://www.javbus.com/genre")).toBe(false);
    const html =
      '<a class="movie-box" href="https://javbus.com/TEST-001/"><img title="安全纪录片" /><date>TEST-001</date></a>';
    expect(parseJavbusWorks(html, url, 1).items[0]?.url).toBe(`${origin}/TEST-001`);
  });
});
