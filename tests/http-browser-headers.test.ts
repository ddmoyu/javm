import { describe, expect, it } from "vite-plus/test";
import { browserHeaders } from "../frontend/src/services/network/browserHeaders";
import type { HttpRequest } from "../frontend/src/services/network/HttpService";

const request: HttpRequest = {
  url: "https://safe.invalid/mock",
  purpose: "catalog",
  maxBytes: 100,
  timeoutMs: 1000,
};
const browser = {
  userAgent: "Safe WebView Mock/1",
  languages: ["zh-CN", "en-US"],
  language: "zh-CN",
};
describe("常驻 HTTP 浏览器请求头（安全 mock）", () => {
  it("使用运行中的 WebView 标识和语言，声明的压缩编码与实际解码能力一致", () => {
    expect(browserHeaders(request, browser)).toEqual({
      "User-Agent": "Safe WebView Mock/1",
      "Accept-Language": "zh-CN,en-US;q=0.9",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "identity",
    });
  });
  it("来源请求头按大小写无关地覆盖默认值，以标准大小写发送且不产生重复 User-Agent", () => {
    const headers = browserHeaders(
      {
        ...request,
        headers: {
          "user-agent": "Safe caller",
          ACCEPT: "application/json",
          Referer: "https://safe.invalid/",
        },
      },
      browser,
    );
    expect(headers).toMatchObject({
      "User-Agent": "Safe caller",
      Accept: "application/json",
      Referer: "https://safe.invalid/",
    });
    expect(headers).not.toHaveProperty("user-agent");
    expect(headers).not.toHaveProperty("ACCEPT");
    expect(headers).not.toHaveProperty("Cookie");
    expect(headers).not.toHaveProperty("Sec-CH-UA");
  });
  it.each(["portrait", "artwork", "metadata", "resolution", "proxy"] as const)(
    "按请求用途选择 Accept：%s",
    (purpose) => {
      const headers = browserHeaders({ ...request, purpose }, browser);
      if (["portrait", "artwork"].includes(purpose)) expect(headers.Accept).toContain("image/");
      else expect(headers.Accept).toBe(purpose === "metadata" ? "application/json" : "*/*");
    },
  );
  it("过滤异常语言标签，避免生成畸形请求头", () => {
    const headers = browserHeaders(request, {
      ...browser,
      languages: ["en\r\nX-Test: mock", "zh-CN"],
      language: "",
    });
    expect(headers["Accept-Language"]).toBe("zh-CN");
  });
});
