import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { normalizedPath, pathComparisonKey, pathRelativeTo } from "../frontend/src/services/paths";
import { joinPath } from "../frontend/src/services/downloads/input";
import { filename, parentDirectory } from "../frontend/src/services/library/maintenanceRules";
import { playbackRequest, playbackSourceKey } from "../frontend/src/services/playback/source";
import { NativeLibraryPort } from "../frontend/src/platform/neutralino/library";

const fixture = vi.hoisted(() => ({ mounts: {} as Record<string, string> }));
vi.mock("@neutralinojs/lib", () => ({
  events: {},
  extensions: {},
  filesystem: {},
  server: {
    getMounts: async () => ({ ...fixture.mounts }),
    mount: async (prefix: string, target: string) => {
      fixture.mounts[prefix] = target;
    },
    unmount: async (prefix: string) => {
      delete fixture.mounts[prefix];
    },
  },
}));
beforeEach(() => {
  fixture.mounts = {};
  vi.stubGlobal("window", { NL_PORT: 54321 });
});
afterEach(() => vi.unstubAllGlobals());

it("POSIX 保留大小写、冒号和反斜杠，目录边界不能混淆", () => {
  expect(pathComparisonKey("/Safe/A\\B:片库/")).toBe("/Safe/A\\B:片库");
  expect(pathComparisonKey("/safe")).not.toBe(pathComparisonKey("/Safe"));
  expect(pathRelativeTo("/Safe/视频\\风景.mp4", "/Safe")).toBe("视频\\风景.mp4");
  for (const candidate of [
    "/safe/film.mp4",
    "/Safe-copy/film.mp4",
    "/Safe/../other.mp4",
    "/Safe/./film.mp4",
  ])
    expect(pathRelativeTo(candidate, "/Safe")).toBeUndefined();
  expect(pathRelativeTo("/safe.mp4", "/")).toBe("safe.mp4");
  expect(joinPath("/Safe/字面\\", "film.mp4")).toBe("/Safe/字面\\/film.mp4");
  expect(filename("/Safe/字面\\电影.mp4")).toBe("字面\\电影.mp4");
  expect(parentDirectory("/Safe/字面\\电影.mp4")).toBe("/Safe");
  expect(parentDirectory("/film.mp4")).toBe("/");
});
it("Windows 继续支持盘符、UNC 和不区分大小写的路径", () => {
  expect(normalizedPath("C:\\")).toBe("C:/");
  expect(pathRelativeTo("c:\\SAFE\\山林.mp4", "C:/Safe")).toBe("山林.mp4");
  expect(pathRelativeTo("\\\\server\\Share\\山林.mp4", "//SERVER/share")).toBe("山林.mp4");
  expect(parentDirectory("C:\\film.mp4")).toBe("C:/");
});
it("文件 URL 解码后再次检查控制字符，POSIX 播放身份保留原始文件名", () => {
  const request = playbackRequest("file:///Safe/%E9%A3%8E%E6%99%AF%5C1.mp4");
  expect(request.source).toBe("/Safe/风景\\1.mp4");
  expect(playbackSourceKey(request)).not.toBe(
    playbackSourceKey(playbackRequest("/safe/风景\\1.mp4")),
  );
  expect(() => playbackRequest("file:///Safe/a%00.mp4")).toThrow("无效字符");
});
it("挂载只发布实际目录下的 URL，按组件编码 POSIX 特殊文件名", async () => {
  const mount = await new NativeLibraryPort().mount([{ id: "safe", path: "/Safe/资料" }]);
  expect(mount("/Safe/资料/风景\\1 #2.jpg")).toBe(
    `http://localhost:54321/javm-media/safe/${encodeURIComponent("风景\\1 #2.jpg")}`,
  );
  expect(mount("/safe/资料/film.jpg")).toBeUndefined();
  expect(mount("/Safe/资料外/film.jpg")).toBeUndefined();
  fixture.mounts["/javm-media/safe"] = "/safe/资料";
  const changed = await new NativeLibraryPort().mount([{ id: "safe", path: "/Safe/资料" }]);
  expect(changed("/Safe/资料/film.jpg")).toBeUndefined();
});
