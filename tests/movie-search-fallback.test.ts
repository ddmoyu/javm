import { describe, expect, it, vi } from "vite-plus/test";
import { JavbusMovieLookup } from "../frontend/src/services/catalog/JavbusMovieLookup";
import { parseJavbusWorkDetails } from "../frontend/src/services/catalog/javbusWorks";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import {
  requireMovieDetails,
  searchMovieMetadata,
} from "../frontend/src/services/metadata/movieSearch";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

const code = "SAFE-777";
const origin = "https://www.javbus.com";
const html = (number = code) => `<h3>${number} 安全旅行纪录片</h3>
<a class="bigImage" href="https://images.example.invalid/safe-cover.png"><img src="https://images.example.invalid/safe-cover.png"></a>
<div class="info"><p>識別碼: ${number}</p><p>發行日期: 2026-01-01</p><p>長度: 80分鐘</p>
<p>製作商: <a href="/studio/safe">虚构制作商</a></p></div>
<a class="sample-box" href="https://images.example.invalid/safe-preview.png">安全预览占位</a>`;
const processor: CatalogProcessor = {
  run: (async (operation: CatalogRequest["operation"], payload: CatalogRequest["payload"]) => {
    const task = { operation, payload } as CatalogRequest;
    if (task.operation !== "javbusDetails") throw new Error("只允许安全详情解析");
    return parseJavbusWorkDetails(task.payload.html, task.payload.work);
  }) as CatalogProcessor["run"],
  close() {},
};
const details: MovieDetails = {
  provider: "Fixture",
  id: code,
  fields: { code, title: "安全旅行纪录片" },
  homepage: "https://example.invalid/safe",
};

describe("搜索无结果与精确番号后备详情", () => {
  it("资料服务空结果时读取并校验作品详情，再返回影片和已缓存的图片资料", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(`${origin}/${code}`);
      return html();
    });
    const lookup = new JavbusMovieLookup(processor, fetch);
    try {
      const result = await searchMovieMetadata(
        { search: async () => [], lookupByCode: (value, signal) => lookup.read(value, signal) },
        code.toLowerCase(),
        new AbortController().signal,
        true,
      );
      expect(result.candidates).toEqual([
        { provider: "JavBus", id: code, code, title: `${code} 安全旅行纪录片` },
      ]);
      expect(result.details?.coverCandidates).toContain(
        "https://images.example.invalid/safe-cover.png",
      );
      expect(result.details?.previewImages).toContain(
        "https://images.example.invalid/safe-preview.png",
      );
      expect(result.resourceCode).toBeUndefined();
      expect(result.error).toBe("");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await lookup.shutdown();
    }
  });

  it("两分区均无详情时只保留按番号查找入口，不伪造一部影片", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("未找到影片资料");
    });
    const lookup = new JavbusMovieLookup(processor, fetch);
    try {
      const result = await searchMovieMetadata(
        { search: async () => [], lookupByCode: (value, signal) => lookup.read(value, signal) },
        code,
        new AbortController().signal,
        true,
      );
      expect(result).toEqual({ candidates: [], resourceCode: code, error: "未找到影片资料" });
      expect(fetch.mock.calls).toHaveLength(2);
    } finally {
      await lookup.shutdown();
    }
  });

  it("资料服务失败或返回无身份占位时可以恢复，片名搜索不猜测番号", async () => {
    const lookupByCode = vi.fn(async () => details);
    const failed = await searchMovieMetadata(
      {
        search: async () => {
          throw new Error("安全模拟离线");
        },
        lookupByCode,
      },
      code,
      new AbortController().signal,
      true,
    );
    expect(failed.details).toBe(details);
    const placeholder = await searchMovieMetadata(
      {
        search: async () => [{ provider: "", id: `code:${code}`, code, title: code }],
        lookupByCode,
      },
      code,
      new AbortController().signal,
      true,
    );
    expect(placeholder.candidates[0]?.provider).toBe("Fixture");
    const title = await searchMovieMetadata(
      { search: async () => [], lookupByCode },
      "安全旅行纪录片",
      new AbortController().signal,
      true,
    );
    expect(title).toEqual({ candidates: [], resourceCode: undefined, error: "" });
    expect(lookupByCode).toHaveBeenCalledTimes(2);
  });

  it("有真实候选时不额外请求，采用资料模式也不构造资源占位", async () => {
    const candidate = { provider: "Fixture", id: code, code, title: "安全旅行纪录片" };
    const lookupByCode = vi.fn(async () => details);
    const result = await searchMovieMetadata(
      { search: async () => [candidate], lookupByCode },
      code,
      new AbortController().signal,
      true,
    );
    expect(result.candidates).toEqual([candidate]);
    expect(lookupByCode).not.toHaveBeenCalled();
    const unavailable = await searchMovieMetadata(
      { search: async () => [], lookupByCode },
      code,
      new AbortController().signal,
      false,
    );
    expect(unavailable.candidates).toEqual([candidate]);
    expect(unavailable.resourceCode).toBeUndefined();
    expect(lookupByCode).toHaveBeenCalledTimes(1);
  });

  it("拒绝空详情、只有番号的详情以及身份不匹配的资料", async () => {
    const candidate = { provider: "Fixture", id: code, code, title: "安全旅行纪录片" };
    expect(() => requireMovieDetails({ ...details, fields: {} }, candidate)).toThrow("详情为空");
    expect(() =>
      requireMovieDetails({ ...details, fields: { code, title: code } }, candidate),
    ).toThrow("只返回了番号");
    expect(() =>
      requireMovieDetails(
        { ...details, fields: { code: "SAFE-888", title: "其他安全样例" } },
        candidate,
      ),
    ).toThrow("不一致");
    const result = await searchMovieMetadata(
      {
        search: async () => [],
        lookupByCode: async () => ({ ...details, fields: { code, title: code } }),
      },
      code,
      new AbortController().signal,
      true,
    );
    expect(result.candidates).toEqual([]);
    expect(result.error).toContain("只返回了番号");
  });

  it("首个分区返回其他番号时不采用，只尝试另一个分区的同一番号", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/uncensored/") ? html() : html("SAFE-888"),
    );
    const lookup = new JavbusMovieLookup(processor, fetch);
    try {
      const result = await lookup.read(code, new AbortController().signal);
      expect(result.fields.code).toBe(code);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        `${origin}/${code}`,
        `${origin}/uncensored/${code}`,
      ]);
    } finally {
      await lookup.shutdown();
    }
  });

  it("取消搜索后忽略迟到结果，且不会继续启动后备请求", async () => {
    const abort = new AbortController();
    let finish!: () => void;
    const lookupByCode = vi.fn(async () => details);
    const result = searchMovieMetadata(
      {
        search: () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          }),
        lookupByCode,
      },
      code,
      abort.signal,
      true,
    );
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    finish();
    await rejected;
    expect(lookupByCode).not.toHaveBeenCalled();
  });

  it("请求有界，退出会取消并等待当前读取，不访问第二个分区", async () => {
    const fetch = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          signal.throwIfAborted();
        }),
    );
    const lookup = new JavbusMovieLookup(processor, fetch);
    const result = lookup.read(code, new AbortController().signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await expect(lookup.read(code, new AbortController().signal)).rejects.toThrow("请稍候");
    await lookup.shutdown();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(lookup.read(code, new AbortController().signal)).rejects.toThrow("暂不可用");
  });

  it("清理未确认时停止后备尝试，下次读取前先完成清理", async () => {
    const cleanup = vi.fn(async () => {});
    const fetch = vi
      .fn(async () => html())
      .mockRejectedValueOnce(new StopUnconfirmedError(cleanup));
    const lookup = new JavbusMovieLookup(processor, fetch);
    try {
      await expect(
        searchMovieMetadata(
          { search: async () => [], lookupByCode: (value, signal) => lookup.read(value, signal) },
          code,
          new AbortController().signal,
          true,
        ),
      ).rejects.toBeInstanceOf(StopUnconfirmedError);
      expect(fetch).toHaveBeenCalledTimes(1);
      await lookup.read(code, new AbortController().signal);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[1]!);
    } finally {
      await lookup.shutdown();
    }
  });
});
