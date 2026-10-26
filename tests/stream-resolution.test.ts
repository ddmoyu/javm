import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import { parsePage, parsePlaylist } from "../frontend/src/services/streamResolution/parsers";
import { ResolutionHttpSession } from "../frontend/src/services/streamResolution/http";
import type {
  ResolutionHttpPort,
  ResolutionHttpRequest,
  ResolutionParser,
  ParseTasks,
} from "../frontend/src/services/streamResolution/ports";
import {
  bounds,
  check,
  normalizeRequest,
  ResolutionError,
} from "../frontend/src/services/streamResolution/shared";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

// 完全合成的文字与字节，不是真实影片、网站页面或可播放媒体。
const root = "https://demo.example.invalid";
const unexpectedRequests: string[] = [];
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const vod = (segment = "segment.bin", extra = "") =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${extra}\n#EXTINF:6,\n${segment}\n#EXT-X-ENDLIST`;
const parser: ResolutionParser = {
  async run<K extends keyof ParseTasks>(
    operation: K,
    input: ParseTasks[K]["input"],
    signal: AbortSignal,
  ): Promise<ParseTasks[K]["output"]> {
    check(signal);
    if (operation === "page" && "provider" in input)
      return parsePage(input.body, input.url, input.provider) as ParseTasks[K]["output"];
    if (operation === "playlist" && "url" in input)
      return parsePlaylist(input.body, input.url) as ParseTasks[K]["output"];
    throw new Error("仅解析安全网页或 HLS 样例");
  },
  close() {},
};
type Response = Awaited<ReturnType<ResolutionHttpPort>>;
const response = (
  body: string | ArrayBuffer,
  status = 200,
  headers: Record<string, string> = {},
): Response => ({ status, headers, body: typeof body === "string" ? bytes(body) : body });
function fixtures(routes: Record<string, string | Response>) {
  const requests: ResolutionHttpRequest[] = [];
  const port: ResolutionHttpPort = async (request, signal) => {
    check(signal);
    requests.push(request);
    const route = routes[request.url];
    if (route === undefined) {
      unexpectedRequests.push(request.url);
      throw new Error("访问了 fixture 之外的地址");
    }
    return typeof route === "string" ? response(route) : { ...route, body: route.body.slice(0) };
  };
  return { port, requests };
}
const services: ResolutionService[] = [];
function service(
  http: ResolutionHttpPort,
  extra: Partial<ConstructorParameters<typeof ResolutionService>[0]> = {},
) {
  const value = new ResolutionService({ http, parser, ...extra });
  services.push(value);
  return value;
}
function session(port: ResolutionHttpPort, headers = {}, proxy = "") {
  return new ResolutionHttpSession(
    { url: `${root}/page`, provider: "static-page", headers },
    port,
    proxy,
    Date.now() + bounds.httpMs,
    new AbortController().signal,
    () => {},
  );
}
it.each([200, 403])("Issue12 验证拦截 HTTP %i 保留独立错误类别", async (status) => {
  const http = session(async () => response("", status, { "Cf-Mitigated": "challenge" }));
  await expect(http.get(`${root}/page`, 1024)).rejects.toMatchObject({
    code: "interaction_required",
    fallbackEligible: true,
  });
});
const submit = (value: ResolutionService, url = `${root}/master.m3u8`) =>
  value.submit({ url, provider: "direct-hls" });
async function turns() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.shutdown().catch(() => {})));
  vi.useRealTimers();
  expect(unexpectedRequests.splice(0)).toEqual([]);
});

describe("安全页面解析", () => {
  it("还原转义 URL 并保留签名参数顺序", () => {
    const source = String.raw`const hlsUrl = '/movie/master.m3u8?sig=a%2Fb\u0026z=2&a=1';`;
    expect(parsePage(bytes(source), `${root}/DEMO-001`, "static-page").candidates).toEqual([
      `${root}/movie/master.m3u8?sig=a%2Fb&z=2&a=1`,
    ]);
  });
  it("识别 JSON 后续接口与嵌入页", () => {
    expect(
      parsePage(bytes('{"apiUrl":"/config","embedUrl":"/embed"}'), `${root}/page`, "json-config")
        .next,
    ).toEqual([
      { url: `${root}/config`, provider: "json-config" },
      { url: `${root}/embed`, provider: "static-page" },
    ]);
    expect(
      parsePage(bytes('<iframe src="/embed"></iframe>'), `${root}/page`, "static-page").next[0]
        ?.url,
    ).toBe(`${root}/embed`);
  });
  it("文本解包不执行随附脚本", () => {
    const source = `eval(function(p,a,c,k,e,d){}('0="/1.2";',3,3,'hlsUrl|safe|m3u8'.split('|')));throw new Error('不得执行');`;
    expect(parsePage(bytes(source), `${root}/page`, "packed-script").candidates).toEqual([
      `${root}/safe.m3u8`,
    ]);
  });
  it.each([
    ["static-page", '<form><input type="password"></form>'],
    ["json-config", '{"requiresInteraction":true}'],
  ] as const)("%s 人工交互要求直接结束", (provider, source) => {
    expect(() => parsePage(bytes(source), root, provider)).toThrow(
      expect.objectContaining({ code: "interaction_required" }),
    );
  });
  it("候选、响应及嵌套层数有界", () => {
    const source = Array.from({ length: 40 }, (_, index) => `file='/v${index}.m3u8';`).join("");
    expect(parsePage(bytes(source), root, "static-page").candidates).toHaveLength(16);
    expect(() => parsePage(new ArrayBuffer(bounds.pageBytes + 1), root, "static-page")).toThrow(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
    expect(() =>
      parsePage(bytes('{"child":'.repeat(10) + "{}" + "}".repeat(10)), root, "json-config"),
    ).toThrow();
  });
});

describe("HTTP 与 HLS 验证", () => {
  it("页面候选有效时立即结束，不请求无关嵌入页", async () => {
    const f = fixtures({
      [`${root}/page`]: '<iframe src="/unrelated"></iframe><script>hlsUrl="/master.m3u8";</script>',
      [`${root}/master.m3u8`]: vod(),
      [`${root}/segment.bin`]: response(new ArrayBuffer(188)),
    });
    expect(
      (await service(f.port).submit({ url: `${root}/page`, provider: "static-page" }).result).ok,
    ).toBe(true);
    expect(f.requests).toHaveLength(3);
  });
  it("页面候选失效后继续有界嵌入页解析", async () => {
    const f = fixtures({
      [`${root}/page`]: '<iframe src="/embed"></iframe><script>file="/missing";</script>',
      [`${root}/missing`]: response("", 404),
      [`${root}/embed`]: 'hlsUrl="/master.m3u8";',
      [`${root}/master.m3u8`]: vod(),
      [`${root}/segment.bin`]: response(new ArrayBuffer(188)),
    });
    expect(
      (await service(f.port).submit({ url: `${root}/page`, provider: "static-page" }).result).ok,
    ).toBe(true);
  });
  it("重定向最多三跳，拒绝循环和 HTTPS 降级", async () => {
    let calls = 0;
    const http = session(async () => response("", 302, { location: `/hop-${++calls}` }));
    await expect(http.get(`${root}/page`, 100)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(calls).toBe(4);
    await expect(
      session(async () => response("", 302, { location: `${root}/page` })).get(`${root}/page`, 100),
    ).rejects.toMatchObject({ code: "parse_failed" });
    await expect(
      session(async () => response("", 302, { location: "http://demo.example.invalid/page" })).get(
        `${root}/page`,
        100,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("两步页面、重定向、独立音轨和初始化段通过后返回主清单", async () => {
    const f = fixtures({
      [`${root}/page`]: '<script type="application/json">{"apiUrl":"/config"}</script>',
      [`${root}/config`]: '{"hlsUrl":"/redirect?z=2&a=1"}',
      [`${root}/redirect?z=2&a=1`]: response("", 302, { location: "/v/master.m3u8?z=2&a=1" }),
      [`${root}/v/master.m3u8?z=2&a=1`]:
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Quiet",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO="audio"\nvideo.m3u8',
      [`${root}/v/video.m3u8`]: vod("segment.bin", '#EXT-X-MAP:URI="init.bin",BYTERANGE="8@4"'),
      [`${root}/v/audio.m3u8`]: vod("audio.bin"),
      [`${root}/v/init.bin`]: response(new ArrayBuffer(8), 206, {
        "content-range": "bytes 4-11/32",
      }),
      [`${root}/v/segment.bin`]: response(new ArrayBuffer(188)),
      [`${root}/v/audio.bin`]: response(new ArrayBuffer(188)),
    });
    const result = await service(f.port).submit({ url: `${root}/page`, provider: "static-page" })
      .result;
    expect(result).toMatchObject({
      ok: true,
      streams: [
        {
          manifestUrl: `${root}/v/master.m3u8?z=2&a=1`,
          tracks: [{ kind: "video", height: 720 }, { kind: "audio" }],
        },
      ],
    });
    expect(f.requests.find((item) => item.url.endsWith("init.bin"))?.range).toEqual({
      start: 4,
      length: 8,
    });
    expect(f.requests).toHaveLength(9);
  });
  it("AES-128 密钥必须为 16 字节，解析显式及隐式字节范围", async () => {
    const playlist = vod(
      "clip.bin",
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001\n#EXT-X-BYTERANGE:8@4',
    );
    const f = fixtures({
      [`${root}/master.m3u8`]: playlist,
      [`${root}/key.bin`]: response(new ArrayBuffer(16)),
      [`${root}/clip.bin`]: response(new ArrayBuffer(8), 206, {
        "content-range": "bytes 4-11/100",
      }),
    });
    expect((await submit(service(f.port)).result).ok).toBe(true);
    const implicit = vod(
      "clip.bin",
      "#EXT-X-GAP\n#EXTINF:6,\n#EXT-X-BYTERANGE:8@4\nclip.bin\n#EXT-X-BYTERANGE:8",
    );
    expect(parsePlaylist(bytes(implicit), `${root}/master.m3u8`)).toMatchObject({
      first: { range: { start: 12, length: 8 } },
    });
    const bad = fixtures({
      [`${root}/master.m3u8`]: playlist,
      [`${root}/key.bin`]: response(new ArrayBuffer(15)),
    });
    expect(await submit(service(bad.port)).result).toMatchObject({
      ok: false,
      code: "parse_failed",
    });
  });
  it.each([
    ["HTML 错误页", "<html>安全错误页</html>", "parse_failed"],
    ["直播", vod().replace("#EXT-X-ENDLIST", ""), "unsupported_stream"],
    ["缺少时长上限", vod().replace("#EXT-X-TARGETDURATION:6", ""), "parse_failed"],
    [
      "不支持的加密",
      vod("s.bin", '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"'),
      "unsupported_stream",
    ],
    ["循环主清单", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmaster.m3u8", "parse_failed"],
  ])("%s 不产生成功结果", async (_name, content, code) => {
    const f = fixtures({ [`${root}/master.m3u8`]: content! });
    expect(await submit(service(f.port)).result).toMatchObject({ ok: false, code });
  });
  it("选定音频失效时不返回仅视频成功", async () => {
    const f = fixtures({
      [`${root}/master.m3u8`]:
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Quiet",URI="missing.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nvideo.m3u8',
      [`${root}/video.m3u8`]: vod(),
      [`${root}/segment.bin`]: response(new ArrayBuffer(188)),
      [`${root}/missing.m3u8`]: response("", 404),
    });
    expect(await submit(service(f.port)).result).toMatchObject({ ok: false, code: "not_found" });
  });
  it("首个候选失效时验证下一项，快照不包含签名或凭据", async () => {
    const f = fixtures({
      [`${root}/page?token=private`]: 'file="/missing";hlsUrl="/master.m3u8";',
      [`${root}/missing`]: response("", 404),
      [`${root}/master.m3u8`]: vod(),
      [`${root}/segment.bin`]: response(new ArrayBuffer(188)),
    });
    const value = service(f.port);
    expect(
      (
        await value.submit({
          provider: "static-page",
          url: `${root}/page?token=private`,
          headers: { Authorization: "Bearer secret" },
        }).result
      ).ok,
    ).toBe(true);
    expect(JSON.stringify(value.getSnapshot())).not.toMatch(/private|secret|https:/);
  });
  it.each([401, 404, 410, 429])("HTTP %s 不允许 WebView 回退", async (status) => {
    const f = fixtures({ [`${root}/master.m3u8`]: response("", status) });
    expect(await submit(service(f.port)).result).toMatchObject({
      ok: false,
      fallbackEligible: false,
    });
  });
  it("动态页面与普通 403 只报告回退资格，不启动任何浏览器", async () => {
    for (const content of [response("<p>DEMO-001 动态占位页</p>"), response("", 403)]) {
      const f = fixtures({ [`${root}/page`]: content });
      expect(
        await service(f.port).submit({ url: `${root}/page`, provider: "static-page" }).result,
      ).toMatchObject({ ok: false, code: "parse_failed", fallbackEligible: true });
    }
  });
  it("跨域跳转移除全部自定义头，保留签名顺序", async () => {
    const target = "https://cdn.example.invalid/master?z=2&sig=a%2Fb&a=1";
    const f = fixtures({
      [`${root}/page`]: response("", 302, { location: target }),
      [target]: response("safe"),
    });
    await session(f.port, {
      cookie: "private=1",
      authorization: "Bearer secret",
      "x-token": "secret",
    }).get(`${root}/page`, 100);
    expect(f.requests[0]?.headers.cookie).toBe("private=1");
    expect(f.requests[1]).toMatchObject({ url: target, headers: {} });
  });
  it("服务端忽略 Range、错误 Content-Range 和超限响应失败", async () => {
    for (const reply of [
      response(new ArrayBuffer(9)),
      response(new ArrayBuffer(8), 206, { "content-range": "bytes 0-7/100" }),
      response(new ArrayBuffer(8)),
    ]) {
      const f = fixtures({ [`${root}/part`]: reply });
      await expect(
        session(f.port).get(`${root}/part`, 8, { start: 4, length: 8 }),
      ).rejects.toBeInstanceOf(ResolutionError);
    }
  });
  it("直连网络失败最多切换一次代理，计入 32 次请求预算", async () => {
    const calls: string[] = [];
    const port: ResolutionHttpPort = async (request) => {
      calls.push(request.proxy);
      if (!request.proxy) throw new ResolutionError("network_error");
      return response("safe");
    };
    const http = session(port, {}, "http://proxy.example.invalid:8080");
    await http.get(`${root}/page`, 100);
    expect(calls).toEqual(["", "http://proxy.example.invalid:8080"]);
    for (let i = 0; i < 30; i++) await http.get(`${root}/page`, 100);
    await expect(http.get(`${root}/page`, 100)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(calls).toHaveLength(32);
  });
  it("非法 URL、凭据和头注入拒绝", () => {
    for (const url of ["file:///x", "https://user:pass@example.invalid/x", "https://a.invalid/\n"])
      expect(() => normalizeRequest({ url, provider: "direct-hls" })).toThrow();
    expect(() =>
      normalizeRequest({
        url: root,
        provider: "direct-hls",
        headers: { Authorization: "ok\r\nX: injected" },
      }),
    ).toThrow();
  });
});

describe("应用级调度与退出", () => {
  function pendingPort() {
    const active: {
      resolve(value: Response): void;
      signal: AbortSignal;
      request: ResolutionHttpRequest;
    }[] = [];
    const http: ResolutionHttpPort = (request, signal) =>
      new Promise((resolve, reject) => {
        active.push({ resolve, signal, request });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    return { http, active };
  }
  it("活跃最多 4、同来源 2、等待最多 32；重复请求共享任务", async () => {
    const p = pendingPort(),
      value = service(p.http);
    const first = submit(value);
    expect(submit(value)).toBe(first);
    for (let i = 0; i < 35; i++)
      submit(value, `https://${i % 2 ? "other" : "demo"}.example.invalid/${i}`);
    await turns();
    expect(p.active).toHaveLength(4);
    expect(p.active.filter((item) => item.request.url.startsWith(root))).toHaveLength(2);
    expect(value.getSnapshot().tasks.filter((item) => item.state === "queued")).toHaveLength(32);
    expect(await submit(value, `${root}/overflow`).result).toMatchObject({
      code: "limit_exceeded",
    });
    first.cancel();
    expect(await first.result).toMatchObject({ code: "cancelled" });
  });
  it("取消不提前伪报停止，迟到的成功响应被丢弃", async () => {
    let respond!: (value: Response) => void;
    const value = service(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const handle = submit(value);
    await turns();
    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    handle.cancel();
    await turns();
    expect(settled).toBe(false);
    expect(value.getSnapshot().tasks[0]?.state).toBe("closing");
    respond(response(vod()));
    expect(await handle.result).toMatchObject({ code: "cancelled" });
  });
  it("HTTP 总时限包含准备阶段，等待队列有独立过期时间", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const prepare = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const value = service(async () => response(""), { prepare: () => prepare });
    const a = submit(value, `${root}/a`),
      b = submit(value, `${root}/b`),
      queued = submit(value, `${root}/c`);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await queued.result).toMatchObject({ code: "timeout" });
    ready();
    expect(await a.result).toMatchObject({ code: "timeout" });
    expect(await b.result).toMatchObject({ code: "timeout" });
  });
  it("清理未确认时阻止新任务；退出重试成功后才释放记录", async () => {
    let mayStop = false;
    const retry = vi.fn(async () => {
      if (!mayStop) throw new Error("mock stop pending");
    });
    const value = service(async () => {
      throw new StopUnconfirmedError(retry);
    });
    expect(await submit(value).result).toMatchObject({ code: "cleanup_failed" });
    expect(value.getSnapshot().cleanupPending).toBe(1);
    expect(await submit(value, `${root}/second`).result).toMatchObject({ code: "cleanup_failed" });
    await expect(value.shutdown()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(value.getSnapshot().cleanupPending).toBe(1);
    mayStop = true;
    await value.shutdown();
    expect(value.getSnapshot().cleanupPending).toBe(0);
  });
});
