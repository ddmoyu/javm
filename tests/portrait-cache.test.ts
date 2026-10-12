import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";

const fixture = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  requests: [] as string[],
  mounted: [] as string[],
  failMirror: false,
}));
vi.mock("@neutralinojs/lib", () => ({
  os: { getEnv: async () => "C:/SafeFixture/AppData/Local" },
  filesystem: {
    createDirectory: async () => {},
    readDirectory: async (directory: string) =>
      [...fixture.files.keys()]
        .filter((name) => name.startsWith(`${directory}/`))
        .map((name) => ({ entry: name.slice(directory.length + 1), type: "FILE" })),
    getStats: async (name: string) => {
      const bytes = fixture.files.get(name);
      if (!bytes) throw new Error("missing");
      return { isFile: true, size: bytes.length, modifiedAt: Date.now() };
    },
    readBinaryFile: async (name: string, { pos, size }: { pos: number; size: number }) =>
      fixture.files.get(name)!.slice(pos, pos + size).buffer,
    move: async (from: string, to: string) => {
      fixture.files.set(to, fixture.files.get(from)!);
      fixture.files.delete(from);
    },
    remove: async (name: string) => {
      fixture.files.delete(name);
    },
  },
  server: {
    mount: async (_prefix: string, path: string) => {
      fixture.mounted.push(path);
    },
    unmount: async () => {},
  },
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({
  requestHttp: async ({ url, output: path }: { url: string; output: string }) => {
    fixture.requests.push(url);
    // 纯字节夹具，不读取或下载真实图片。
    fixture.files.set(
      path,
      url.endsWith(".json")
        ? new TextEncoder().encode('{"Content":{"Fixture":{"Safe.jpg":"Safe.jpg"}}}')
        : Uint8Array.from([255, 216, 255, 0]),
    );
    return {
      exitCode: 0,
      status: fixture.failMirror && url.includes("jsdelivr") ? 503 : 200,
    };
  },
}));
vi.mock("../frontend/src/platform/neutralino/playbackResources", () => ({
  mediaResourceUrl: (path: string) => `http://fixture.invalid${path}`,
}));
import { createPortraitPort } from "../frontend/src/platform/neutralino/portraits";

afterEach(() => {
  vi.unstubAllEnvs();
  fixture.files.clear();
  fixture.requests.length = 0;
  fixture.mounted.length = 0;
  fixture.failMirror = false;
});
describe("AppData 持久头像缓存", () => {
  it("重启后复用头像和备用索引，不重复发出下载请求", async () => {
    vi.stubEnv("DEV", false);
    const network = { getProxy: async () => "" } as unknown as NetworkSettingsService;
    const first = createPortraitPort(network, async () => {});
    const signal = new AbortController().signal;
    await first.load(
      "https://raw.githubusercontent.com/gfriends/gfriends/master/Content/Fixture/Safe.jpg",
      signal,
      "actresses:安全示例",
    );
    await first.index(signal);
    await first.shutdown();
    expect(fixture.requests.length).toBe(2);
    const second = createPortraitPort(network, async () => {});
    expect(await second.cached!("actresses", ["安全示例"], signal)).toHaveProperty("安全示例");
    await second.index(signal);
    await second.shutdown();
    expect(fixture.requests.length).toBe(2);
    expect(fixture.mounted).toEqual(
      Array(2).fill("C:/SafeFixture/AppData/Local/JAVM/cache/portraits"),
    );
    expect([...fixture.files.keys()].filter((name) => name.endsWith(".jpg")).length).toBe(1);
    expect([...fixture.files.keys()].some((name) => name.endsWith(".part"))).toBe(false);
  });
  it("开发模式禁用真实头像适配器，不触发下载或缓存读写", async () => {
    const port = createPortraitPort(
      { getProxy: async () => "" } as unknown as NetworkSettingsService,
      async () => {},
    );
    await expect(
      port.load(
        "https://raw.githubusercontent.com/gfriends/gfriends/master/Content/Fixture/Safe.jpg",
        new AbortController().signal,
        "actresses:安全示例",
      ),
    ).rejects.toThrow("开发模式");
    expect(fixture.requests).toEqual([]);
    expect(fixture.files.size).toBe(0);
    await port.shutdown();
  });
  it("备用镜像失效后尝试原始地址，失败文件不会留在缓存", async () => {
    vi.stubEnv("DEV", false);
    fixture.failMirror = true;
    const port = createPortraitPort(
      { getProxy: async () => "" } as unknown as NetworkSettingsService,
      async () => {},
    );
    await port.index(new AbortController().signal);
    expect(fixture.requests).toEqual([
      "https://cdn.jsdelivr.net/gh/xinxin8816/gfriends/Filetree.json",
      "https://raw.githubusercontent.com/gfriends/gfriends/master/Filetree.json",
    ]);
    expect([...fixture.files.keys()].some((name) => name.endsWith(".part"))).toBe(false);
    await port.shutdown();
  });
});
