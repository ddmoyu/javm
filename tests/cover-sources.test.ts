import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import type { HttpRequest } from "../frontend/src/services/network/HttpService";

const fixture = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  requests: [] as HttpRequest[],
  unmount: vi.fn(),
  png: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
}));
vi.mock("@neutralinojs/lib", () => ({
  os: { getEnv: async () => "C:/SafeFixture/Local" },
  filesystem: {
    createDirectory: async () => {},
    readDirectory: async (directory: string) =>
      [...fixture.files.keys()]
        .filter((file) => file.startsWith(`${directory}/`))
        .map((file) => ({ entry: file.slice(directory.length + 1), type: "FILE" })),
    getStats: async (file: string) => {
      const bytes = fixture.files.get(file);
      if (!bytes) throw Object.assign(new Error("safe mock missing"), { code: "NE_FS_NOPATHE" });
      return { isFile: true, size: bytes.length, modifiedAt: Date.now() };
    },
    readBinaryFile: async (file: string, { pos, size }: { pos: number; size: number }) =>
      fixture.files.get(file)!.slice(pos, pos + size).buffer,
    move: async (from: string, to: string) => {
      fixture.files.set(to, fixture.files.get(from)!);
      fixture.files.delete(from);
    },
    remove: async (file: string) => {
      fixture.files.delete(file);
    },
  },
  server: { mount: async () => {}, unmount: fixture.unmount },
}));
vi.mock("../frontend/src/platform/neutralino/playbackResources", () => ({
  mediaResourceUrl: (path: string) => `http://localhost${path}`,
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: async (request: HttpRequest, signal: AbortSignal) => {
    fixture.requests.push(request);
    if (request.url.endsWith("/slow"))
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    signal.throwIfAborted();
    const html = request.url.endsWith("/html");
    const status = request.url.endsWith("/denied") ? 403 : 200;
    fixture.files.set(
      request.output!,
      html ? new TextEncoder().encode("<html>Safe mock verification</html>") : fixture.png,
    );
    return { status, exitCode: 0, headers: { "content-type": html ? "text/html" : "image/png" } };
  },
}));
import {
  createImageSourcePort,
  imageExtension,
} from "../frontend/src/platform/neutralino/imageSources";
import {
  ImageSourceService,
  imageCandidates,
  isLocalImage,
} from "../frontend/src/services/images/ImageSourceService";
import {
  parseJavbusWorks,
  parseJavbusWorkDetails,
} from "../frontend/src/services/catalog/javbusWorks";
import { movieDetailsToFilm } from "../frontend/src/features/resources/movieDetailsFilm";

const network = {
  getProxy: async () => "http://127.0.0.1:12345",
} as unknown as NetworkSettingsService;
const page = "https://catalog.example.invalid/SAFE-001";
const image = (name: string) => `https://images.example.invalid/${name}`;
const signal = () => new AbortController().signal;
const parts = () => [...fixture.files.keys()].filter((file) => file.endsWith(".part"));
beforeEach(() => {
  vi.stubGlobal("window", { NL_OS: "Windows" });
  vi.stubEnv("DEV", false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fixture.files.clear();
  fixture.requests.length = 0;
  fixture.unmount.mockClear();
});

describe("封面后台读取和备用图片（纯安全 mock）", () => {
  it("系统清理图片文件后可以剔除失效记录，不让缓存阻断备用图", async () => {
    const service = new ImageSourceService(createImageSourcePort(network, async () => {}));
    await service.resolve([image("cleaned.png")], page, signal());
    fixture.files.clear();
    await service.invalidate(image("cleaned.png"), page);
    const result = await service.resolve(
      [image("cleaned.png"), image("backup.png")],
      page,
      signal(),
    );
    expect(result.source).toBe(image("backup.png"));
    await service.shutdown();
  });
  it("403 和伪图片失败后采用备用图，携带应用代理、来源页，重开和重启复用缓存", async () => {
    const values = [image("denied"), image("html"), image("cover.png")];
    const first = new ImageSourceService(createImageSourcePort(network, async () => {}));
    const result = await first.resolve(values, page, signal());
    expect(result.source).toBe(values[2]);
    expect(result.src).toMatch(/^http:\/\/localhost\/javm-images\/.*\.png$/);
    for (const request of fixture.requests) {
      expect(request.proxy).toBe("http://127.0.0.1:12345");
      expect(request.headers?.Referer).toBe(page);
      expect(request.maxRedirects).toBe(3);
      expect(request.purpose).toBe("artwork");
      expect(request.maxBytes).toBe(8 * 1024 * 1024);
    }
    expect(parts()).toEqual([]);
    await first.resolve(values, page, signal());
    expect(fixture.requests).toHaveLength(3);
    await first.shutdown();
    const second = new ImageSourceService(createImageSourcePort(network, async () => {}));
    await second.resolve([values[2]!], page, signal());
    expect(fixture.requests).toHaveLength(3);
    await second.shutdown();
    expect(fixture.unmount).toHaveBeenCalledTimes(2);
  });
  it("解码失败时移除坏缓存，短时间不重试同一个地址", async () => {
    const service = new ImageSourceService(createImageSourcePort(network, async () => {}));
    await service.resolve([image("invalid.png")], page, signal());
    await service.invalidate(image("invalid.png"), page);
    const result = await service.resolve(
      [image("invalid.png"), image("valid.png")],
      page,
      signal(),
    );
    expect(result.source).toBe(image("valid.png"));
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.files.size).toBe(1);
    await service.shutdown();
  });
  it("取消后停止读取，不尝试其他图片，不遗留临时文件", async () => {
    const service = new ImageSourceService(createImageSourcePort(network, async () => {}));
    const abort = new AbortController();
    const pending = service.resolve([image("slow"), image("cover.png")], page, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    abort.abort();
    await rejected;
    expect(fixture.requests).toHaveLength(1);
    expect(parts()).toEqual([]);
    await service.shutdown();
  });
  it("退出会取消在途请求，然后卸载图片目录", async () => {
    const service = new ImageSourceService(createImageSourcePort(network, async () => {}));
    const pending = service.resolve([image("slow")], page, signal());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    await service.shutdown();
    await rejected;
    expect(fixture.unmount).toHaveBeenCalledTimes(1);
    await expect(service.resolve([image("cover.png")], page, signal())).rejects.toThrow("繁忙");
  });
  it("开发适配器不会读取真实缓存或发送图片请求", async () => {
    vi.stubEnv("DEV", true);
    const port = createImageSourcePort(network, async () => {});
    await expect(port.load(image("cover.png"), page, signal())).rejects.toThrow("安全图片");
    expect(fixture.requests).toEqual([]);
    expect(fixture.files.size).toBe(0);
    await port.shutdown();
  });
  it("浏览器预览只允许本地图片，远程图片不回退到裸 img 请求", async () => {
    const service = new ImageSourceService();
    expect(await service.resolve(["/safe.png"], undefined, signal())).toMatchObject({
      src: "/safe.png",
    });
    await expect(service.resolve([image("cover.png")], undefined, signal())).rejects.toThrow(
      "暂不可用",
    );
    expect(isLocalImage("javascript:alert(1)")).toBe(false);
    expect(isLocalImage("//images.example.invalid/cover.png")).toBe(false);
    await service.shutdown();
  });
  it("候选去重并设置数量上限，防止异常元数据产生无限请求", () => {
    expect(imageCandidates([undefined, "", image("a"), image("a")])).toEqual([image("a")]);
    expect(
      imageCandidates(Array.from({ length: 100 }, (_, index) => image(String(index)))),
    ).toHaveLength(8);
  });
  it.each([
    ["jpg", [255, 216, 255]],
    ["png", fixture.png],
    ["gif", new TextEncoder().encode("GIF89a")],
    ["webp", new TextEncoder().encode("RIFFxxxxWEBP")],
    ["avif", new TextEncoder().encode("xxxxftypavif")],
    [undefined, new TextEncoder().encode("<html>safe mock</html>")],
  ])("识别图片格式 %s，拒绝把 HTML 当图片", (ext, header) => {
    expect(imageExtension(Uint8Array.from(header! as ArrayLike<number>))).toBe(ext);
  });
});

describe("JavBus 封面候选的解析与传递（虚构文字与地址）", () => {
  // 只核对虚构番号生成的地址顺序，不请求这些地址。
  const preferred = [
    "https://pics.dmm.co.jp/digital/video/safe00001/safe00001pl.jpg",
    "https://pics.dmm.co.jp/mono/movie/adult/safe00001/safe00001pl.jpg",
  ];
  it("兼容无链接的封面容器和 HTTP 图片，由后台读取避免混合内容限制", () => {
    const work = { code: "SAFE-001", title: "安全示例", url: "https://www.javbus.com/SAFE-001" };
    const details = parseJavbusWorkDetails(
      `<h3>安全示例</h3><div class="bigImage"><img data-srcset="http://images.example.invalid/large.jpg 2x"></div><div class="info"><p>ID: SAFE-001</p></div>`,
      work,
    );
    expect(details.coverUrl).toBe(preferred[0]);
    expect(details.coverCandidates).toEqual([
      ...preferred,
      "http://images.example.invalid/large.jpg",
    ]);
  });
  it("卡片保留 lazy 图片、src 和 srcset 的备用地址", () => {
    const result = parseJavbusWorks(
      `<a class="movie-box" href="/SAFE-001"><img title="安全示例" src="/thumb.jpg" data-src="/cover.jpg" srcset="/small.jpg 1x, /large.jpg 2x"><date>SAFE-001</date></a>`,
      "https://www.javbus.com/star/safe",
      1,
    );
    expect(result.items[0]?.coverUrl).toBe(preferred[0]);
    expect(result.items[0]?.coverCandidates).toEqual([
      ...preferred,
      "https://www.javbus.com/cover.jpg",
      "https://www.javbus.com/thumb.jpg",
      "https://www.javbus.com/small.jpg",
      "https://www.javbus.com/large.jpg",
    ]);
  });
  it("详情保留大图链接、img 原图及列表封面，转换为 Film 后均可回退", () => {
    const work = {
      code: "SAFE-001",
      title: "安全示例",
      url: "https://www.javbus.com/SAFE-001",
      coverUrl: "https://images.example.invalid/list.jpg",
    };
    const details = parseJavbusWorkDetails(
      `<h3>安全示例</h3><a class="bigImage" href="https://images.example.invalid/full.jpg"><img src="https://images.example.invalid/medium.jpg"></a><div class="info"><p>ID: SAFE-001</p></div>`,
      work,
    );
    const film = movieDetailsToFilm(details, { ...work, id: work.code, provider: "JavBus" });
    expect(film.artwork?.map((value) => value.src)).toEqual([
      ...preferred,
      "https://images.example.invalid/full.jpg",
      "https://images.example.invalid/medium.jpg",
      work.coverUrl,
    ]);
    expect(film.metadata?.homepage).toBe(work.url);
  });
});
