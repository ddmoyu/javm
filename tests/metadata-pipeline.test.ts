import { describe, it, expect } from "vite-plus/test";
import {
  fuseMetadata,
  retryMetadata,
  MetadataPipeline,
} from "../frontend/src/services/scraping/MetadataPipeline";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import { JsonHttpError } from "../frontend/src/services/metadata/shared";
import { subtitleVtt } from "../frontend/src/services/playback/subtitles";
import { identifyCode } from "../frontend/src/services/scraping/identity";
const movie = (provider: string, title: string): MovieDetails => ({
  provider,
  id: provider,
  homepage: "https://safe.invalid/",
  fields: { code: "SAFE-001", title },
});
describe("已有来源的资料补全与本地字幕安全样例", () => {
  it("只补主来源缺失字段，不采用其他番号或覆盖主来源", () => {
    const a = movie("a", "安全甲"),
      b = {
        ...movie("b", "安全乙"),
        fields: { code: "SAFE-001", title: "安全乙", studio: "虚构制作商" },
      };
    const result = fuseMetadata(a, [
      b,
      { ...movie("c", "错号"), fields: { code: "SAFE-002", title: "错号", director: "错号资料" } },
    ]);
    expect(result.fields.title).toBe("安全甲");
    expect(result.fields.studio).toBe("虚构制作商");
    expect(result.fields.director).toBeUndefined();
    expect(result.fusion?.fields.studio?.provider).toBe("b");
    expect(result.fusion?.fields.title?.provider).toBe("a");
    expect(result.fusion?.sources).toHaveLength(2);
  });
  it("身份不一致的主来源必须拒绝", async () => {
    const pipeline = new MetadataPipeline(
      { search: async () => [], details: async () => movie("wrong", "安全") },
      { read: async () => null, write: async () => {} },
      true,
    );
    await expect(
      pipeline.details(
        { provider: "a", id: "a", code: "SAFE-001", title: "安全" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("身份");
  });
  it("退避有界，普通 4xx 不重试，取消立即终止", async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    const delays: number[] = [];
    expect(
      await retryMetadata(
        async () => {
          if (++calls < 3) throw new JsonHttpError(503, "busy");
          return 7;
        },
        2,
        signal,
        async (ms) => {
          delays.push(ms);
        },
      ),
    ).toBe(7);
    expect(delays).toEqual([1000, 2000]);
    calls = 0;
    await expect(
      retryMetadata(
        async () => {
          calls++;
          throw new JsonHttpError(404, "missing");
        },
        3,
        signal,
      ),
    ).rejects.toThrow("missing");
    expect(calls).toBe(1);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(retryMetadata(async () => 1, 3, cancelled.signal)).rejects.toThrow();
  });
  it("分卷不污染番号，手动提供的字幕转为纯文本且拒绝逆序时间", () => {
    expect(identifyCode("SAFE-001-CD02.mp4")).toBe("SAFE-001");
    const bytes = (s: string) => new TextEncoder().encode(s).buffer;
    expect(
      subtitleVtt(bytes("1\n00:00:00,000 --> 00:00:01,000\n<b>安全样例</b>"), "safe.srt"),
    ).toContain("00:00:00.000 --> 00:00:01.000\n安全样例");
    expect(
      subtitleVtt(
        bytes("[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\b1}安全\\N字幕"),
        "safe.ass",
      ),
    ).toContain("安全\n字幕");
    expect(() => subtitleVtt(bytes("00:00:02.000 --> 00:00:01.000\n无效"), "safe.vtt")).toThrow(
      "有效",
    );
  });
});
