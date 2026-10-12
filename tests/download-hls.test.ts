import { describe, expect, it } from "vite-plus/test";
import {
  attributes,
  hlsFingerprint,
  hlsLimits,
  parseTransfer,
  planTrack,
  playlistDuration,
  playlistFiles,
  readPlaylist,
  selectTracks,
  transferAccepted,
  HlsPlanError,
  HlsSizeEstimate,
  spreadOrder,
} from "../frontend/src/services/downloads/hls";
import type { HlsResource } from "../frontend/src/services/downloads/hls";
import { curlContext, curlSafety, headerName } from "../frontend/src/services/downloads/curlConfig";
import { createHlsPlanner, createPlannerCore } from "../frontend/src/services/downloads/hlsPlanner";
import { mismatchedFiles, readHlsState } from "../frontend/src/services/downloads/hlsDownload";
import type { DownloadFiles } from "../frontend/src/services/downloads/ToolDownloadEngine";
import { canRetryWithProxy, curlExitHint } from "../frontend/src/services/downloads/network";

const base = "https://cdn.example.com/show/master.m3u8";
const master = (text: string) => {
  const playlist = readPlaylist(text, base);
  if (playlist.kind !== "master") throw new Error("expected master");
  return playlist;
};
const media = (...rows: string[]) =>
  ["#EXTM3U", "#EXT-X-TARGETDURATION:4", ...rows, "#EXT-X-ENDLIST"].join("\n");

describe("HLS master playlist selection", () => {
  it("selects the highest bandwidth video and the default audio of its group", () => {
    const playlist = master(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hi",NAME="Alt",URI="audio/alt.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hi",NAME="Main",DEFAULT=YES,URI="audio/main.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="lo",NAME="Low",DEFAULT=YES,URI="audio/low.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="lo"',
        "360/video.m3u8",
        '#EXT-X-STREAM-INF:BANDWIDTH=2800000,AUDIO="hi"',
        "720/video.m3u8",
      ].join("\n"),
    );
    expect(selectTracks(playlist)).toEqual([
      {
        video: "https://cdn.example.com/show/720/video.m3u8",
        audio: "https://cdn.example.com/show/audio/main.m3u8",
        bandwidth: 2800000,
      },
      {
        video: "https://cdn.example.com/show/360/video.m3u8",
        audio: "https://cdn.example.com/show/audio/low.m3u8",
        bandwidth: 800000,
      },
    ]);
  });
  it("keeps muxed audio when the variant has no separate rendition", () => {
    const playlist = master("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvideo.m3u8\n");
    expect(selectTracks(playlist)[0]!.audio).toBeUndefined();
  });
  it("tolerates spaces, lowercase names and commas inside quoted values", () => {
    expect(
      attributes(
        '#EXT-X-STREAM-INF:bandwidth=1200, RESOLUTION = 1280x720 ,CODECS="avc1.4d401f,mp4a.40.2"',
      ),
    ).toEqual({ BANDWIDTH: "1200", RESOLUTION: "1280x720", CODECS: "avc1.4d401f,mp4a.40.2" });
    const playlist = master(
      "#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=1200, RESOLUTION=1280x720\na.m3u8\n",
    );
    expect(playlist.variants[0]).toMatchObject({ bandwidth: 1200, audioOnly: false });
  });
  it("orders variants without BANDWIDTH by average bandwidth or resolution", () => {
    const playlist = master(
      [
        "#EXTM3U",
        "#EXT-X-STREAM-INF:RESOLUTION=640x360",
        "low.m3u8",
        "#EXT-X-STREAM-INF:RESOLUTION=1920x1080",
        "high.m3u8",
        "#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9000000",
        "avg.m3u8",
      ].join("\n"),
    );
    expect(selectTracks(playlist).map((item) => item.video.split("/").at(-1))).toEqual([
      "avg.m3u8",
      "high.m3u8",
      "low.m3u8",
    ]);
  });
  it("skips audio-only variants, removes duplicates and limits fallback candidates", () => {
    const rows = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=9999999,CODECS="mp4a.40.2"',
      "audio-only.m3u8",
    ];
    for (let index = 1; index <= 5; index++)
      rows.push(`#EXT-X-STREAM-INF:BANDWIDTH=${index * 1000}`, `v${index}.m3u8`);
    rows.push("#EXT-X-STREAM-INF:BANDWIDTH=5000", "v5.m3u8");
    const candidates = selectTracks(master(rows.join("\n")));
    expect(candidates).toHaveLength(hlsLimits.candidates);
    expect(candidates.map((item) => item.video.split("/").at(-1))).toEqual([
      "v5.m3u8",
      "v4.m3u8",
      "v3.m3u8",
    ]);
  });
  it("falls back to audio-tagged variants when nothing else is listed", () => {
    const playlist = master('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"\na.m3u8\n');
    expect(selectTracks(playlist)).toHaveLength(1);
  });
  it("ignores malformed audio renditions instead of failing the whole playlist", () => {
    const playlist = master(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="x",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n',
    );
    expect(playlist.audio).toEqual([]);
  });
  it("explains HTML block pages and handles a byte order mark", () => {
    expect(() => readPlaylist("<!DOCTYPE html><title>Just a moment</title>", base)).toThrow(
      "被网站拦截",
    );
    expect(() => readPlaylist("not a playlist", base)).toThrow("不是 HLS");
    expect(readPlaylist(`\uFEFF${media("#EXTINF:4,", "a.ts")}`, base).kind).toBe("media");
  });
});

describe("HLS media playlist planning", () => {
  it("rewrites segments, keys and init maps to local files and deduplicates byte ranges", () => {
    const plan = planTrack(
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        "#EXT-X-MEDIA-SEQUENCE:0",
        '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k?id=1",IV=0x00000000000000000000000000000001',
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:4.0,",
        "#EXT-X-BYTERANGE:1000@0",
        "media.mp4?token=a",
        "#EXTINF:3.5,",
        "#EXT-X-BYTERANGE:900@1000",
        "media.mp4?token=a",
        "#EXTINF:2,",
        "https://other.example.com/x/video9.jpeg",
        "#EXT-X-ENDLIST",
      ].join("\n"),
      "https://cdn.example.com/show/720/video.m3u8",
      "v",
    );
    expect(plan.encrypted).toBe(true);
    expect(plan.duration).toBeCloseTo(9.5);
    expect(plan.resources).toEqual([
      { url: "https://keys.example.com/k?id=1", file: "v-key-00000.key", duration: 0 },
      { url: "https://cdn.example.com/show/720/init.mp4", file: "v-init-00001.mp4", duration: 0 },
      {
        url: "https://cdn.example.com/show/720/media.mp4?token=a",
        file: "v-seg-00002.mp4",
        // 两个字节范围分片共用一个文件，时长累加。
        duration: 7.5,
      },
      { url: "https://other.example.com/x/video9.jpeg", file: "v-seg-00003.m4s", duration: 2 },
    ]);
    expect(plan.playlist).toContain('URI="v-key-00000.key",IV=0x');
    expect(plan.playlist).toContain('#EXT-X-MAP:URI="v-init-00001.mp4"');
    expect(plan.playlist).toContain("#EXT-X-BYTERANGE:900@1000\nv-seg-00002.mp4");
    expect(plan.playlist).not.toContain("https://");
    expect(playlistDuration(plan.playlist)).toBeCloseTo(9.5);
    expect(playlistFiles(plan.playlist)).toEqual([
      "v-key-00000.key",
      "v-init-00001.mp4",
      "v-seg-00002.mp4",
      "v-seg-00003.m4s",
    ]);
  });
  it("names disguised transport stream segments as .ts", () => {
    const plan = planTrack(
      media("#EXTINF:4,", "video0.jpeg"),
      "https://cdn.example.com/a/video.m3u8",
      "a",
    );
    expect(plan.resources).toEqual([
      { url: "https://cdn.example.com/a/video0.jpeg", file: "a-seg-00000.ts", duration: 4 },
    ]);
  });
  it("writes inline data: keys locally instead of downloading them", () => {
    const key = btoa(String.fromCharCode(...Array.from({ length: 16 }, (_, index) => index)));
    const plan = planTrack(
      media(`#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,${key}"`, "#EXTINF:4,", "a.ts"),
      base,
      "v",
    );
    expect(plan.resources[0]).toMatchObject({ file: "v-key-00000.key" });
    expect([...plan.resources[0]!.inline!]).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    expect(plan.playlist).toContain('URI="v-key-00000.key"');
    const percent = planTrack(
      media('#EXT-X-KEY:METHOD=AES-128,URI="data:,0123456789abcdef"', "#EXTINF:4,", "a.ts"),
      base,
      "v",
    );
    expect(percent.resources[0]!.inline).toHaveLength(16);
  });
  it("keeps a key shared by many segments as one download", () => {
    const rows = ['#EXT-X-KEY:METHOD=AES-128,URI="k.bin"'];
    for (let index = 0; index < 4; index++) rows.push("#EXTINF:4,", `s${index}.ts`);
    rows.push('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', "#EXTINF:4,", "s9.ts");
    const plan = planTrack(media(...rows), base, "v");
    expect(plan.resources.filter((item) => item.file.includes("-key-"))).toHaveLength(1);
    expect(plan.resources).toHaveLength(6);
  });
  it("supports METHOD=NONE after encrypted segments", () => {
    const plan = planTrack(
      media(
        '#EXT-X-KEY:METHOD=AES-128,URI="k"',
        "#EXTINF:4,",
        "a.ts",
        "#EXT-X-KEY:METHOD=NONE",
        "#EXTINF:4,",
        "b.ts",
      ),
      base,
      "v",
    );
    expect(plan.playlist).toContain("#EXT-X-KEY:METHOD=NONE");
    expect(plan.encrypted).toBe(true);
  });
  it.each([
    ["#EXTM3U\n#EXTINF:4,\nsegment.ts\n", "直播流"],
    ['#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST', "DRM"],
    [
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST',
      "DRM",
    ],
    ["#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST", "密钥地址"],
    [
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=zz\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST',
      "初始向量",
    ],
    [
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:;base64,AAAA"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST',
      "长度",
    ],
    ["#EXTM3U\n#EXT-X-MAP:BYTERANGE=10\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST", "初始化分片"],
    ["#EXTM3U\nsegment.ts\n#EXT-X-ENDLIST", "时长"],
    ["#EXTM3U\n#EXTINF:abc,\nsegment.ts\n#EXT-X-ENDLIST", "时长无效"],
    ["#EXTM3U\n#EXTINF:4,\nfile:///C:/secret.ts\n#EXT-X-ENDLIST", "不支持的地址"],
    ["#EXTM3U\n#EXTINF:4,\nhttps://user:pass@cdn.example.com/a.ts\n#EXT-X-ENDLIST", "不支持的地址"],
    ["#EXTM3U\n#EXT-X-ENDLIST", "没有可下载的分片"],
    ["#EXTM3U\n#EXT-X-I-FRAMES-ONLY\n#EXT-X-ENDLIST", "结构无效"],
    ["<html>blocked</html>", "不是 HLS"],
  ])("rejects unsupported playlists (%#)", (text, message) => {
    expect(() => planTrack(text, base, "v")).toThrow(message);
  });
  it("bounds the number of resources", () => {
    const rows: string[] = [];
    for (let index = 0; index <= hlsLimits.resources; index++)
      rows.push("#EXTINF:1,", `s${index}.ts`);
    expect(() => planTrack(media(...rows), base, "v")).toThrow("超出限制");
  });
});

describe("HLS resume fingerprint", () => {
  const plan = (query: string, path = "a") =>
    planTrack(media("#EXTINF:4,", `${path}.ts?${query}`, "#EXTINF:4,", "b.ts"), base, "v")
      .resources;
  it("survives rotating signatures but changes when segments change", () => {
    expect(hlsFingerprint(plan("token=1"))).toBe(hlsFingerprint(plan("token=2")));
    expect(hlsFingerprint(plan("token=1"))).not.toBe(hlsFingerprint(plan("token=1", "c")));
    expect(hlsFingerprint(plan("x").slice(0, 1))).not.toBe(hlsFingerprint(plan("x")));
  });
});

describe("curl transfer results", () => {
  it("parses results and ignores other output", () => {
    expect(
      parseTransfer(
        "javm-transfer\t0\t200\t12345\tvideo/mp2t\tC:/Users/a b/.javm-download/hls/v-seg-00007.ts",
      ),
    ).toEqual({
      exitCode: 0,
      status: 200,
      bytes: 12345,
      contentType: "video/mp2t",
      file: "v-seg-00007.ts",
    });
    expect(parseTransfer("javm-transfer\t22\t403\t0\t\tD:\\x\\hls\\v-seg-00001.ts")).toMatchObject({
      exitCode: 22,
      status: 403,
      contentType: "",
      file: "v-seg-00001.ts",
    });
    expect(parseTransfer("curl: (22) The requested URL returned error: 403")).toBeUndefined();
    expect(parseTransfer("javm-transfer\tx\t200\t1\t\ta.ts")).toBeUndefined();
  });
  it("rejects failures, empty bodies and small HTML block pages", () => {
    const ok = {
      exitCode: 0,
      status: 200,
      bytes: 500_000,
      contentType: "video/mp2t",
      file: "a.ts",
    };
    expect(transferAccepted(ok)).toBe(true);
    expect(transferAccepted({ ...ok, status: 206 })).toBe(true);
    expect(transferAccepted({ ...ok, exitCode: 28 })).toBe(false);
    expect(transferAccepted({ ...ok, status: 404 })).toBe(false);
    expect(transferAccepted({ ...ok, bytes: 0 })).toBe(false);
    expect(transferAccepted({ ...ok, contentType: "text/html; charset=utf-8", bytes: 4000 })).toBe(
      false,
    );
    // 体积很大的分片即使被错误标成 HTML，也按正常分片接受。
    expect(transferAccepted({ ...ok, contentType: "text/html" })).toBe(true);
  });
  it("explains common curl exit codes and keeps proxy retry to network failures", () => {
    expect(curlExitHint(23)).toContain("磁盘");
    expect(curlExitHint(28)).toContain("超时");
    expect(curlExitHint(999)).toBe("");
    const result = (exitCode: number) => ({ exitCode, stdOut: "", stdErr: "" });
    expect(canRetryWithProxy(result(22))).toBe(true);
    expect(canRetryWithProxy(result(28))).toBe(true);
    expect(canRetryWithProxy(result(23))).toBe(false);
    expect(canRetryWithProxy(result(0))).toBe(false);
    expect(canRetryWithProxy(result(-1))).toBe(false);
  });
  it("sends browser-style header names to curl", () => {
    expect(headerName("user-agent")).toBe("User-Agent");
    expect(headerName("x-custom-token")).toBe("X-Custom-Token");
    expect(headerName("Referer")).toBe("Referer");
    expect(
      curlContext({ headers: { "user-agent": "UA", origin: "https://a.example" } }, ""),
    ).toEqual([
      'proxy = ""',
      'noproxy = "*"',
      'header = "User-Agent: UA"',
      'header = "Origin: https://a.example"',
    ]);
    expect(curlContext({ headers: { referer: 'a"b\\c' } }, "socks5h://127.0.0.1:1")).toEqual([
      'proxy = "socks5h://127.0.0.1:1"',
      'noproxy = ""',
      'header = "Referer: a\\"b\\\\c"',
    ]);
  });
});

describe("HLS size estimate", () => {
  const resource = (track: "v" | "a", index: number, duration = 4): HlsResource => ({
    url: `https://cdn.example.com/${track}${index}.ts`,
    file: `${track}-seg-${String(index).padStart(5, "0")}.ts`,
    duration,
  });
  /** 合成一部 1000 段的影片：片头片尾码率低，中段高；音频分片小而稳定。 */
  const film = () => {
    const resources: HlsResource[] = [
      { url: "https://cdn.example.com/k", file: "v-key-00000.key", duration: 0 },
    ];
    const sizes = new Map<string, number>();
    for (let index = 0; index < 1000; index++) {
      const item = resource("v", index + 1, index === 999 ? 1.5 : 4);
      resources.push(item);
      const position = index / 1000;
      const scene = position < 0.1 || position > 0.9 ? 0.3 : 1 + 0.5 * Math.sin(index / 7);
      sizes.set(item.file, Math.round(item.duration * 250_000 * scene));
    }
    for (let index = 0; index < 1000; index++) {
      const item = resource("a", index + 1, index === 999 ? 1.5 : 4);
      resources.push(item);
      sizes.set(item.file, Math.round(item.duration * 16_000));
    }
    sizes.set("v-key-00000.key", 16);
    const actual = [...sizes.values()].reduce((sum, value) => sum + value, 0);
    return { resources, sizes, actual };
  };
  it("is exact when every file is complete", () => {
    const { resources, sizes, actual } = film();
    const estimate = new HlsSizeEstimate(resources);
    for (const [file, bytes] of sizes) estimate.record(file, bytes);
    expect(estimate.snapshot()).toEqual({
      downloaded: actual,
      total: actual,
      progress: 100,
      estimated: false,
    });
  });
  it("stays within a few percent after 5% of a spread download", () => {
    const { resources, sizes, actual } = film();
    const ordered = spreadOrder(resources);
    const estimate = new HlsSizeEstimate(resources);
    for (const item of ordered.slice(0, Math.ceil(resources.length * 0.05)))
      estimate.record(item.file, sizes.get(item.file)!);
    const spread = estimate.snapshot().total;
    expect(Math.abs(spread - actual) / actual).toBeLessThan(0.05);
    // 旧算法：按时间顺序下载，分片平均大小 × 分片总数。
    const sequential = resources.slice(0, Math.ceil(resources.length * 0.05));
    const bytes = sequential.reduce((sum, item) => sum + sizes.get(item.file)!, 0);
    const naive = (bytes / sequential.length) * resources.length;
    expect(Math.abs(naive - actual) / actual).toBeGreaterThan(0.3);
  });
  it("starts from the declared bitrate and converges to measured data", () => {
    const { resources, sizes } = film();
    const prior = 50_000_000;
    const estimate = new HlsSizeEstimate(resources, prior);
    expect(estimate.snapshot()).toMatchObject({ downloaded: 0, total: prior, estimated: true });
    const ordered = spreadOrder(resources);
    for (const item of ordered.slice(0, 200)) estimate.record(item.file, sizes.get(item.file)!);
    const measured = new HlsSizeEstimate(resources);
    for (const item of ordered.slice(0, 200)) measured.record(item.file, sizes.get(item.file)!);
    // 样本已覆盖超过 3% 的时长，完全采用实测值。
    expect(estimate.snapshot().total).toBe(measured.snapshot().total);
  });
  it("fills an unsampled audio track from the declared bitrate", () => {
    const resources = [resource("v", 1), resource("v", 2), resource("a", 1), resource("a", 2)];
    const estimate = new HlsSizeEstimate(resources, 3_000_000);
    estimate.record(resources[0]!.file, 1_000_000);
    estimate.record(resources[1]!.file, 1_000_000);
    expect(estimate.snapshot().total).toBe(3_000_000);
  });
  it("never reports less than the downloaded bytes and ignores unknown files", () => {
    const resources = [resource("v", 1), resource("v", 2)];
    const estimate = new HlsSizeEstimate(resources, 10);
    estimate.record(resources[0]!.file, 5_000);
    estimate.record("not-in-plan.ts", 1_000_000);
    estimate.record(resources[0]!.file, 6_000);
    expect(estimate.snapshot()).toMatchObject({ downloaded: 6_000, total: 12_000 });
    expect(estimate.snapshot().progress).toBeCloseTo(50);
  });
  it("reports only known bytes until a media segment arrives without a declared bitrate", () => {
    const resources: HlsResource[] = [
      { url: "https://cdn.example.com/k", file: "v-key-00000.key", duration: 0 },
      resource("v", 1),
      resource("v", 2),
    ];
    const estimate = new HlsSizeEstimate(resources);
    estimate.record("v-key-00000.key", 16);
    expect(estimate.snapshot()).toMatchObject({ total: 16, estimated: true });
  });
});

describe("HLS spread download order", () => {
  it("puts keys first, visits every segment once and spreads early samples", () => {
    const resources: HlsResource[] = [
      { url: "https://cdn.example.com/k", file: "v-key-00000.key", duration: 0 },
    ];
    for (let index = 1; index <= 100; index++)
      resources.push({
        url: `https://cdn.example.com/${index}`,
        file: `v-seg-${index}.ts`,
        duration: 4,
      });
    for (let index = 1; index <= 30; index++)
      resources.push({
        url: `https://cdn.example.com/a${index}`,
        file: `a-seg-${index}.ts`,
        duration: 4,
      });
    const ordered = spreadOrder(resources);
    expect(ordered[0]!.file).toBe("v-key-00000.key");
    expect(new Set(ordered.map((item) => item.file)).size).toBe(resources.length);
    expect(ordered).toHaveLength(resources.length);
    const early = ordered.slice(1, 9).map((item) => item.file);
    expect(early.some((file) => file.startsWith("a-"))).toBe(true);
    const positions = ordered
      .slice(1, 17)
      .filter((item) => item.file.startsWith("v-"))
      .map((item) => Number(item.file.slice(6, -3)));
    expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(60);
  });
  it("handles a single segment and large plans quickly", () => {
    expect(spreadOrder([{ url: "https://a/1", file: "v-seg-1.ts", duration: 1 }])).toHaveLength(1);
    const many = Array.from({ length: 50_000 }, (_, index) => ({
      url: `https://a/${index}`,
      file: `v-seg-${index}.ts`,
      duration: 1,
    }));
    const started = performance.now();
    expect(spreadOrder(many)).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("review fixes", () => {
  it("keeps a muxed DEFAULT audio instead of switching to a separate alternative", () => {
    const playlist = master(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Commentary",URI="commentary.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud"',
        "video.m3u8",
      ].join("\n"),
    );
    expect(selectTracks(playlist)[0]!.audio).toBeUndefined();
  });
  it("still downloads a separate DEFAULT audio rendition", () => {
    const playlist = master(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Alt",URI="alt.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="main.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud"',
        "video.m3u8",
      ].join("\n"),
    );
    expect(selectTracks(playlist)[0]!.audio).toBe("https://cdn.example.com/show/main.m3u8");
  });
  it("decodes percent-encoded binary key bytes such as %FF", () => {
    const plan = planTrack(
      media('#EXT-X-KEY:METHOD=AES-128,URI="data:,%FF%00%80%7Fabcdefghijkl"', "#EXTINF:4,", "a.ts"),
      base,
      "v",
    );
    expect([...plan.resources[0]!.inline!.slice(0, 4)]).toEqual([0xff, 0x00, 0x80, 0x7f]);
    expect(plan.resources[0]!.inline).toHaveLength(16);
    expect(() =>
      planTrack(
        media('#EXT-X-KEY:METHOD=AES-128,URI="data:,%G0abcdefghijklmn"', "#EXTINF:4,", "a.ts"),
        base,
        "v",
      ),
    ).toThrow("格式无效");
  });
  it("separates resources that differ only by quality parameter, host or inline key", () => {
    const resources = (segment: string, key = "") =>
      planTrack(
        media(...(key ? [key] : []), "#EXTINF:4,", segment, "#EXTINF:4,", "b.ts"),
        base,
        "v",
      ).resources;
    const fingerprint = (segment: string, key = "") => hlsFingerprint(resources(segment, key));
    // 只有签名、时效参数变化时仍视为同一资源。
    expect(fingerprint("a.ts?quality=720&token=1&expires=10")).toBe(
      fingerprint("a.ts?expires=99&quality=720&token=2"),
    );
    expect(fingerprint("a.ts?quality=720")).not.toBe(fingerprint("a.ts?quality=360"));
    expect(fingerprint("https://cdn1.example.com/a.ts")).not.toBe(
      fingerprint("https://cdn2.example.com/a.ts"),
    );
    const key = (value: string) => `#EXT-X-KEY:METHOD=AES-128,URI="data:,${value.padEnd(16, "0")}"`;
    expect(fingerprint("a.ts", key("first"))).not.toBe(fingerprint("a.ts", key("second")));
  });
  it("keeps generic short parameter names as part of the resource identity", () => {
    const fingerprint = (segment: string) =>
      hlsFingerprint(planTrack(media("#EXTINF:4,", segment), base, "v").resources);
    // t、hash、e 这类泛用名字可能就是清晰度或内容哈希，不能当作签名忽略。
    for (const [first, second] of [
      ["a.ts?t=720", "a.ts?t=360"],
      ["a.ts?hash=aaa", "a.ts?hash=bbb"],
      ["a.ts?e=1", "a.ts?e=2"],
      ["a.ts?ts=1", "a.ts?ts=2"],
    ])
      expect(fingerprint(first!)).not.toBe(fingerprint(second!));
    expect(fingerprint("a.ts?X-Amz-Signature=1&X-Amz-Date=1")).toBe(
      fingerprint("a.ts?X-Amz-Signature=2&X-Amz-Date=2"),
    );
  });
  it("includes the selected playlists so variants sharing segment names stay apart", () => {
    const resources = planTrack(media("#EXTINF:4,", "seg-1.ts"), base, "v").resources;
    expect(hlsFingerprint(resources, ["https://cdn.example.com/720/index.m3u8"])).not.toBe(
      hlsFingerprint(resources, ["https://cdn.example.com/360/index.m3u8"]),
    );
    expect(hlsFingerprint(resources, ["https://cdn.example.com/720/index.m3u8?token=1"])).toBe(
      hlsFingerprint(resources, ["https://cdn.example.com/720/index.m3u8?token=2"]),
    );
  });
  it("turns off curl URL globbing for every request", () => {
    expect(curlSafety).toContain("--globoff");
  });
});

describe("HLS planner", () => {
  const playlistText = media(
    "#EXTINF:4,",
    "a.ts?sig=1",
    "#EXTINF:4,",
    "b.ts",
    "#EXTINF:4,",
    "c.ts",
  );
  it("parses, plans and builds a curl list without finished or inline files", async () => {
    const planner = createHlsPlanner();
    const signal = new AbortController().signal;
    expect(await planner.run("parse", { text: playlistText, url: base }, signal)).toEqual({
      kind: "media",
    });
    const plan = await planner.run(
      "plan",
      { tracks: [{ prefix: "v", text: playlistText, url: base }] },
      signal,
    );
    expect(plan.files).toEqual(["v-seg-00000.ts", "v-seg-00001.ts", "v-seg-00002.ts"]);
    expect(plan.durations).toEqual([4, 4, 4]);
    const config = await planner.run(
      "config",
      { head: ['proxy = ""'], root: "C:/work/hls", completed: ["v-seg-00001.ts"] },
      signal,
    );
    expect(config.pending).toBe(2);
    expect(config.config.startsWith('proxy = ""\n')).toBe(true);
    expect(config.config).toContain('output = "C:/work/hls/v-seg-00000.ts"');
    expect(config.config).not.toContain("v-seg-00001.ts");
    expect(await planner.run("files", { text: plan.playlists[0]!.playlist }, signal)).toEqual({
      files: plan.files,
      duration: 12,
    });
  });
  /** 与浏览器 Worker 相同的消息接口，在当前线程里异步执行核心计算。 */
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    private core = createPlannerCore();
    constructor(private readonly stall = false) {}
    postMessage(data: { id: number; operation: "parse"; input: { text: string; url: string } }) {
      if (this.stall) return;
      setTimeout(() => {
        if (this.terminated) return;
        try {
          const value = this.core.handle(data.operation, data.input);
          this.onmessage?.({ data: { id: data.id, value } } as MessageEvent);
        } catch (error) {
          this.onmessage?.({
            data: {
              id: data.id,
              error: { message: (error as Error).message, plan: error instanceof HlsPlanError },
            },
          } as MessageEvent);
        }
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  it("routes work through the Worker and restores plan errors", async () => {
    const workers: FakeWorker[] = [];
    const planner = createHlsPlanner(() => {
      workers.push(new FakeWorker());
      return workers.at(-1) as unknown as Worker;
    });
    const signal = new AbortController().signal;
    expect(await planner.run("parse", { text: playlistText, url: base }, signal)).toEqual({
      kind: "media",
    });
    const failure = planner.run("parse", { text: "<html>", url: base }, signal);
    await expect(failure).rejects.toBeInstanceOf(HlsPlanError);
    expect(workers).toHaveLength(1);
    planner.close();
    expect(workers[0]!.terminated).toBe(true);
    await expect(planner.run("parse", { text: playlistText, url: base }, signal)).rejects.toThrow(
      "已关闭",
    );
  });
  it("terminates a busy Worker on cancellation and starts a fresh one afterwards", async () => {
    const workers: FakeWorker[] = [];
    const planner = createHlsPlanner(() => {
      workers.push(new FakeWorker(workers.length === 0));
      return workers.at(-1) as unknown as Worker;
    });
    const controller = new AbortController();
    const pending = planner.run("parse", { text: playlistText, url: base }, controller.signal);
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    expect(workers[0]!.terminated).toBe(true);
    const next = await planner.run(
      "parse",
      { text: playlistText, url: base },
      new AbortController().signal,
    );
    expect(next).toEqual({ kind: "media" });
    expect(workers).toHaveLength(2);
  });
  it("rejects pending work when the Worker crashes", async () => {
    let worker: FakeWorker | undefined;
    const planner = createHlsPlanner(() => {
      worker = new FakeWorker(true);
      return worker as unknown as Worker;
    });
    const pending = planner.run(
      "parse",
      { text: playlistText, url: base },
      new AbortController().signal,
    );
    worker!.onerror?.();
    await expect(pending).rejects.toThrow("异常退出");
  });
});

describe("HLS local file checks", () => {
  const files = (sizes: Record<string, number>, state?: string): DownloadFiles => ({
    mkdir: async () => {},
    stat: async (path) => {
      const name = path.split("/").at(-1)!;
      return name in sizes ? { size: sizes[name]!, isFile: true } : null;
    },
    read: async () => {
      if (state === undefined) throw new Error("missing");
      return state;
    },
    write: async () => {},
    list: async () => [],
    move: async () => {},
    remove: async () => {},
  });
  it("flags missing, empty and truncated files against the recorded sizes", async () => {
    const result = await mismatchedFiles(
      files({ "a.ts": 100, "b.ts": 40, "c.ts": 0, "e.ts": 7 }),
      "C:/work",
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      { "a.ts": 100, "b.ts": 100, "c.ts": 5, "d.ts": 9, "e.ts": 7 },
      new AbortController().signal,
    );
    expect(result.sort()).toEqual(["b.ts", "c.ts", "d.ts"]);
  });
  it("treats a present file without a completion record as incomplete", async () => {
    // 被强制结束时写了一半、尚未记录的分片：文件存在且非空，但不能当作完整。
    const result = await mismatchedFiles(
      files({ "a.ts": 100, "half.ts": 50 }),
      "C:/work",
      ["a.ts", "half.ts"],
      { "a.ts": 100 },
      new AbortController().signal,
    );
    expect(result).toEqual(["half.ts"]);
    expect(
      await mismatchedFiles(
        files({ "a.ts": 100 }),
        "C:/work",
        ["a.ts"],
        {},
        new AbortController().signal,
      ),
    ).toEqual(["a.ts"]);
  });
  it("stops checking when cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      mismatchedFiles(files({ "a.ts": 1 }), "C:/work", ["a.ts"], {}, controller.signal),
    ).rejects.toThrow("stopped");
  });
  it.each([
    ['{"fingerprint":"x","completed":{"a', undefined],
    ['{"fingerprint":1,"completed":{}}', undefined],
    ['{"fingerprint":"x","completed":[]}', undefined],
  ])("ignores malformed progress records (%#)", async (text, expected) => {
    expect(await readHlsState(files({ "state.json": 1 }, text), "C:/work")).toEqual(expected);
  });
  it("keeps only positive numeric sizes from a progress record", async () => {
    const text = '{"fingerprint":"x","completed":{"a.ts":10,"b.ts":-1,"c.ts":"9","d.ts":0}}';
    expect(await readHlsState(files({ "state.json": 1 }, text), "C:/work")).toEqual({
      fingerprint: "x",
      completed: { "a.ts": 10 },
    });
  });
});
