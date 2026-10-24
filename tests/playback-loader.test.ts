import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hls } from "@videojs/hlsjs-video";
import type {
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
} from "../frontend/src/services/playback/hlsLoader";
import { createHlsLoader } from "../frontend/src/services/playback/hlsLoader";

const config: LoaderConfiguration = {
  loadPolicy: Hls.DefaultConfig.fragLoadPolicy.default,
  timeout: 10000,
  maxRetry: 0,
  retryDelay: 0,
  maxRetryDelay: 0,
};
const context: LoaderContext = {
  url: "https://example.test/segment.ts",
  responseType: "arraybuffer",
  rangeStart: 0,
  rangeEnd: 0,
};
const callbacks = (): LoaderCallbacks => ({
  onSuccess: vi.fn(),
  onError: vi.fn(),
  onTimeout: vi.fn(),
  onAbort: vi.fn(),
  onProgress: vi.fn(),
});

describe("native HLS loader contract", () => {
  beforeEach(() => vi.stubGlobal("self", globalThis));
  afterEach(() => vi.unstubAllGlobals());
  it("delivers bytes to the demuxer and treats hls.js zero range as a full segment", async () => {
    const data = new Uint8Array([0x47, 0, 0, 0x10]).buffer;
    const fetch = vi.fn(async () => ({ url: "https://cdn.test/segment.ts", data }));
    const Loader = createHlsLoader(fetch, true);
    const loader = new Loader(Hls.DefaultConfig);
    const handlers = callbacks();
    loader.load(context, config, handlers);
    await vi.waitFor(() => expect(handlers.onSuccess).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(context.url, expect.any(AbortSignal), undefined);
    expect(handlers.onProgress).toHaveBeenCalledWith(loader.stats, context, data, null);
    expect(handlers.onSuccess).toHaveBeenCalledWith(
      { url: "https://cdn.test/segment.ts", data, code: 200 },
      loader.stats,
      context,
      null,
    );
    expect(loader.stats.loaded).toBe(4);
    expect(Number.isFinite(loader.stats.bwEstimate)).toBe(true);
    loader.destroy();
  });
  it("preserves an exclusive byte range and reports abort without a late success", async () => {
    let resolve!: (value: { url: string; data: ArrayBuffer }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{ url: string; data: ArrayBuffer }>((done) => {
          resolve = done;
        }),
    );
    const Loader = createHlsLoader(fetch, true);
    const loader = new Loader(Hls.DefaultConfig);
    const handlers = callbacks();
    loader.load({ ...context, rangeStart: 100, rangeEnd: 200 }, config, handlers);
    expect(fetch).toHaveBeenCalledWith(context.url, expect.any(AbortSignal), {
      start: 100,
      end: 200,
    });
    loader.abort();
    resolve({ url: context.url, data: new ArrayBuffer(100) });
    await Promise.resolve();
    expect(handlers.onAbort).toHaveBeenCalledOnce();
    expect(handlers.onSuccess).not.toHaveBeenCalled();
    expect(loader.stats.aborted).toBe(true);
    loader.destroy();
  });
});
