import { afterEach, expect, it, vi } from "vite-plus/test";
import { ArtworkService } from "../frontend/src/services/library/ArtworkService";
import type { ArtworkTarget, ArtworkTools } from "../frontend/src/services/library/ArtworkService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(count = 8) {
  const files = new Map<string, ArrayBuffer>();
  const gates = Array.from({ length: count }, deferred);
  const target: ArtworkTarget = {
    directory: "C:/SafeFixture/metadata/safe/images",
    poster: "",
    code: "SAFE-001",
    title: "安全样例",
    source: {},
    videos: [],
  };
  const details: MovieDetails = {
    provider: "fixture",
    id: "safe",
    homepage: "https://safe.example.invalid/work",
    fields: { code: target.code },
    previewImages: Array.from({ length: count }, (_, i) => `https://safe.example.invalid/${i}.jpg`),
  };
  let committed: { path: string; kind: string }[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "library.artwork.prepare") return target;
    if (method === "library.artwork.commit") {
      committed = (params as { images: typeof committed }).images;
      return { retired: [] };
    }
    throw new Error("Unknown safe operation");
  });
  const tools = {
    mkdir: async () => {},
    read: async (path) => files.get(path)!.slice(0),
    write: vi.fn(async (path, bytes) => {
      files.set(path, bytes);
    }),
    remove: vi.fn(async (path) => {
      for (const file of files.keys())
        if (file === path || file.startsWith(`${path}/`)) files.delete(file);
    }),
    frame: async () => {},
    transform: async (buffers) => buffers[0]!,
    download: vi.fn<ArtworkTools["download"]>(async (url, _referer, path) => {
      files.set(path, Uint8Array.of(Number(new URL(url).pathname.slice(1).split(".")[0])).buffer);
    }),
    details: async () => details,
  } satisfies ArtworkTools;
  const service = new ArtworkService(
    { request: request as LibraryPort["request"] },
    tools,
    async () => {},
  );
  cleanups.push(async () => {
    gates.forEach((gate) => gate.resolve());
    await service.shutdown();
  });
  return { service, tools, details, files, gates, request, committed: () => committed };
}

it("缺失图片最多四张在途，乱序完成仍按来源顺序保存", async () => {
  const f = fixture();
  let running = 0,
    peak = 0;
  vi.mocked(f.tools.download).mockImplementation(async (url, _referer, path) => {
    const index = Number(new URL(url).pathname.slice(1).split(".")[0]);
    peak = Math.max(peak, ++running);
    await f.gates[index]!.promise;
    f.files.set(path, Uint8Array.of(index).buffer);
    running--;
  });
  const pending = f.service.fetch("safe", false, true, f.details);
  await vi.waitFor(() => expect(f.tools.download).toHaveBeenCalledTimes(4));
  expect(f.service.getSnapshot().processed).toBe(0);
  for (const [index, total] of [
    [3, 5],
    [4, 6],
    [2, 7],
    [1, 8],
  ]) {
    f.gates[index!]!.resolve();
    await vi.waitFor(() => expect(f.tools.download).toHaveBeenCalledTimes(total!));
  }
  f.gates.forEach((gate) => gate.resolve());
  await pending;
  expect(peak).toBe(4);
  expect(f.committed().map((image) => new Uint8Array(f.files.get(image.path)!)[0])).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(f.service.getSnapshot()).toMatchObject({
    busy: false,
    processed: 8,
    total: 8,
    warning: "",
  });
});

it("并行请求中的坏图不会丢失其他结果，封面仍可使用备用地址", async () => {
  const f = fixture(4);
  const original = f.tools.download.getMockImplementation()!;
  vi.mocked(f.tools.download).mockImplementation(async (url, ...args) => {
    if (url.endsWith("/bad.jpg") || url.endsWith("/2.jpg")) throw new Error("Safe missing image");
    await original(url, ...args);
  });
  await f.service.fetch("safe", true, true, {
    ...f.details,
    coverUrl: "https://safe.example.invalid/bad.jpg",
    coverCandidates: ["https://safe.example.invalid/9.jpg"],
  });
  expect(f.committed().map((image) => new Uint8Array(f.files.get(image.path)!)[0])).toEqual([
    9, 0, 1, 3,
  ]);
  expect(f.committed()[0]?.kind).toBe("poster");
  expect(f.service.getSnapshot()).toMatchObject({
    busy: false,
    processed: 5,
    total: 5,
    warning: expect.stringContaining("1 张"),
  });
});

it("取消会停止派发，并等全部在途任务结束后才清理临时目录", async () => {
  const f = fixture();
  vi.mocked(f.tools.download).mockImplementation(async (url) => {
    await f.gates[Number(new URL(url).pathname.slice(1).split(".")[0])]!.promise;
  });
  const pending = f.service.fetch("safe", false, true, f.details);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.tools.download).toHaveBeenCalledTimes(4));
  f.service.cancel();
  f.gates.slice(0, 3).forEach((gate) => gate.resolve());
  await Promise.resolve();
  expect(f.service.getSnapshot().busy).toBe(true);
  expect(f.tools.remove).not.toHaveBeenCalled();
  f.gates[3]!.resolve();
  await rejected;
  expect(f.tools.download).toHaveBeenCalledTimes(4);
  expect(f.tools.write).not.toHaveBeenCalled();
  expect(f.committed()).toEqual([]);
  expect(f.tools.remove).toHaveBeenCalledOnce();
});

it("并发任务均未确认停止时，保留全部停止句柄，确认完成后才清理", async () => {
  const f = fixture();
  const retryA = vi
    .fn()
    .mockRejectedValueOnce(new Error("Safe stop pending"))
    .mockResolvedValue(undefined);
  const retryB = vi.fn(async () => {});
  const stops = [new StopUnconfirmedError(retryA), new StopUnconfirmedError(retryB)];
  vi.mocked(f.tools.download).mockImplementation(async (url, _referer, _path, signal) => {
    const index = Number(new URL(url).pathname.slice(1).split(".")[0]);
    await f.gates[index]!.promise;
    if (stops[index]) throw stops[index];
    signal.throwIfAborted();
  });
  const pending = f.service.fetch("safe", false, true, f.details);
  const rejected = expect(pending).rejects.toBeInstanceOf(StopUnconfirmedError);
  await vi.waitFor(() => expect(f.tools.download).toHaveBeenCalledTimes(4));
  f.gates.forEach((gate) => gate.resolve());
  await rejected;
  expect(f.tools.remove).not.toHaveBeenCalled();
  await expect(f.service.shutdown()).rejects.toThrow("Safe stop pending");
  expect(f.tools.remove).not.toHaveBeenCalled();
  await f.service.shutdown();
  expect(retryA).toHaveBeenCalledTimes(2);
  expect(retryB).toHaveBeenCalledOnce();
  expect(f.tools.remove).toHaveBeenCalledOnce();
  expect(f.committed()).toEqual([]);
});
