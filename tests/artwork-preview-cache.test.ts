import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { HttpRequest } from "../frontend/src/services/network/HttpService";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import type {
  MetaTubeService,
  MovieDetails,
} from "../frontend/src/services/metadata/MetaTubeService";
import type { LibraryService, LibraryPort } from "../frontend/src/services/library/LibraryService";
import { ImageSourceService } from "../frontend/src/services/images/ImageSourceService";
import { createImageSourcePort } from "../frontend/src/platform/neutralino/imageSources";
import { createArtworkService } from "../frontend/src/platform/neutralino/artwork";
import { NativeLibraryPort } from "../frontend/src/platform/neutralino/library";

const fixture = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  requests: [] as HttpRequest[],
  offline: false,
  copying: undefined as (() => Promise<void>) | undefined,
  // 安全签名夹具，仅模拟传输；不展示或解码真实图片。
  bytes: Uint8Array.from([255, 216, 255, 217]),
}));
vi.mock("@neutralinojs/lib", () => ({
  events: {},
  extensions: {},
  os: { getEnv: async () => "C:/SafeFixture/Local" },
  server: { mount: async () => {}, unmount: async () => {} },
  filesystem: {
    createDirectory: async () => {},
    readDirectory: async () => [],
    getStats: async (path: string) => {
      const bytes = fixture.files.get(path);
      if (!bytes) throw Object.assign(new Error("Safe missing file"), { code: "NE_FS_NOPATHE" });
      return { isFile: true, size: bytes.length, modifiedAt: Date.now() };
    },
    readBinaryFile: async (path: string, { pos, size }: { pos: number; size: number }) =>
      fixture.files.get(path)!.slice(pos, pos + size).buffer,
    writeBinaryFile: async (path: string, bytes: ArrayBuffer) => {
      fixture.files.set(path, new Uint8Array(bytes));
    },
    appendBinaryFile: async (path: string, bytes: ArrayBuffer) => {
      const previous = fixture.files.get(path)!;
      const next = new Uint8Array(previous.length + bytes.byteLength);
      next.set(previous);
      next.set(new Uint8Array(bytes), previous.length);
      fixture.files.set(path, next);
    },
    move: async (from: string, to: string) => {
      fixture.files.set(to, fixture.files.get(from)!);
      fixture.files.delete(from);
    },
    copy: async (from: string, to: string) => {
      await fixture.copying?.();
      fixture.files.set(to, fixture.files.get(from)!.slice());
    },
    remove: async (path: string) => {
      for (const file of fixture.files.keys())
        if (file === path || file.startsWith(`${path}/`)) fixture.files.delete(file);
    },
  },
}));
vi.mock("../frontend/src/platform/neutralino/playbackResources", () => ({
  mediaResourceUrl: (path: string) => `http://localhost${path}`,
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: async (request: HttpRequest, signal: AbortSignal) => {
    fixture.requests.push(request);
    signal.throwIfAborted();
    if (fixture.offline) throw new Error("Safe offline fixture");
    fixture.files.set(request.output!, fixture.bytes.slice());
    return { status: 200, exitCode: 0, headers: { "content-type": "image/jpeg" } };
  },
}));
const network = { getProxy: async () => "" } as NetworkSettingsService;
const page = "https://safe.example.invalid/work";
const image = (name: string) => `https://safe.example.invalid/images/${name}.jpg`;
const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv("DEV", false);
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: { data: { bytes: ArrayBuffer } }) => void;
      postMessage({ buffers }: { buffers: ArrayBuffer[] }) {
        queueMicrotask(() => this.onmessage?.({ data: { bytes: buffers[0]! } }));
      }
      terminate() {}
    },
  );
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.files.clear();
  fixture.requests.length = 0;
  fixture.offline = false;
  fixture.copying = undefined;
  fixture.bytes = Uint8Array.from([255, 216, 255, 217]);
});
function sources() {
  const service = new ImageSourceService(createImageSourcePort(network, async () => {}));
  cleanups.push(() => service.shutdown());
  return service;
}

it("详情已加载的封面及预览图直接用于收藏，即使离线也不再下载或重试主图", async () => {
  // 跨过多个 256 KiB 边界，检查分块读写不会截断或打乱图片字节。
  fixture.bytes = Uint8Array.from({ length: 700001 }, (_, index) => index % 251);
  fixture.bytes.set([255, 216, 255]);
  const images = sources();
  const details: MovieDetails = {
    provider: "fixture",
    id: "safe",
    homepage: page,
    fields: { code: "SAFE-001" },
    bigCoverUrl: image("uncached-primary"),
    coverUrl: image("cached-backup"),
    previewImages: [image("preview-1"), image("preview-2")],
  };
  for (const url of [details.coverUrl!, ...details.previewImages!])
    await images.resolve([url], page, signal());
  expect(fixture.requests).toHaveLength(3);
  const cachedFiles = [...fixture.files.keys()];
  fixture.offline = true;
  let committed: { path: string; kind: string }[] = [];
  vi.spyOn(NativeLibraryPort.prototype, "request").mockImplementation((async (
    method: string,
    params?: unknown,
  ) => {
    if (method === "library.artwork.prepare")
      return {
        directory: "C:/SafeFixture/metadata/safe/images",
        poster: "",
        code: "SAFE-001",
        title: "安全样例",
        source: {},
        videos: [],
      };
    committed = (params as { images: typeof committed }).images;
    return { retired: [] };
  }) as LibraryPort["request"]);
  const service = createArtworkService(
    "desktop",
    { refreshAfterImport: async () => {} } as LibraryService,
    {} as MetaTubeService,
    network,
    () => "",
    images,
  )!;
  cleanups.unshift(() => service.shutdown());
  await service.fetch("safe", true, true, details);
  expect(service.getSnapshot()).toMatchObject({ processed: 3, total: 3, error: "", warning: "" });
  expect(committed.map((image) => image.kind)).toEqual(["poster", "screenshot", "screenshot"]);
  for (const image of committed) expect(fixture.files.get(image.path)).toEqual(fixture.bytes);
  for (const file of cachedFiles) expect(fixture.files.has(file)).toBe(true);
  expect(fixture.requests).toHaveLength(3);
});

it("缓存按来源页隔离，已删除和过期缓存都返回未命中且不自行联网", async () => {
  const images = sources();
  await images.resolve([image("cover")], page, signal());
  expect(
    await images.copyCached(
      [image("cover")],
      `${page}/another`,
      "C:/SafeFixture/copy.jpg",
      signal(),
    ),
  ).toBe(false);
  const file = [...fixture.files.keys()][0]!;
  fixture.files.delete(file);
  expect(await images.copyCached([image("cover")], page, "C:/SafeFixture/copy.jpg", signal())).toBe(
    false,
  );
  await images.resolve([image("fresh")], page, signal());
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
  expect(await images.copyCached([image("fresh")], page, "C:/SafeFixture/copy.jpg", signal())).toBe(
    false,
  );
  expect(fixture.requests).toHaveLength(2);
});

it("缓存复制完成前不能被并发失效清理，保存副本独立保留", async () => {
  const images = sources();
  await images.resolve([image("cover")], page, signal());
  const source = [...fixture.files.keys()][0]!;
  let finish!: () => void;
  fixture.copying = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = images.copyCached([image("cover")], page, "C:/SafeFixture/copy.jpg", signal());
  await vi.waitFor(() => expect(finish).toBeDefined());
  const invalidated = images.invalidate(image("cover"), page);
  expect(fixture.files.has(source)).toBe(true);
  finish();
  expect(await pending).toBe(true);
  await invalidated;
  expect(fixture.files.has(source)).toBe(false);
  expect(fixture.files.get("C:/SafeFixture/copy.jpg")).toEqual(fixture.bytes);
  expect(fixture.requests).toHaveLength(1);
});

it("退出等待正在进行的缓存复制收尾，取消后不返回成功", async () => {
  const images = sources();
  await images.resolve([image("cover")], page, signal());
  let finish!: () => void;
  fixture.copying = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pending = images.copyCached([image("cover")], page, "C:/SafeFixture/copy.jpg", signal());
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeDefined());
  let stopped = false;
  const shutdown = images.shutdown().then(() => {
    stopped = true;
  });
  expect(stopped).toBe(false);
  finish();
  await rejected;
  await shutdown;
  expect(stopped).toBe(true);
  expect(fixture.requests).toHaveLength(1);
});
