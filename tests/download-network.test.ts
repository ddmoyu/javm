import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { filesystem, storage } from "@neutralinojs/lib";
import { createNetworkSettings } from "../frontend/src/platform/neutralino/network";
import { ToolDownloadEngine } from "../frontend/src/services/downloads/ToolDownloadEngine";
import type { DownloadHost } from "../frontend/src/services/downloads/ToolDownloadEngine";
import { createDownloadTasks, redactLog } from "../frontend/src/services/downloads/input";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import { validateNetworkSettings } from "../frontend/src/contracts/network";
import type { ProcessResult, ProcessRunner } from "../frontend/src/platform/neutralino/process";

vi.mock("@neutralinojs/lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neutralinojs/lib")>();
  return {
    ...actual,
    storage: { ...actual.storage, getKeys: vi.fn(), getData: vi.fn(), setData: vi.fn() },
    filesystem: { ...actual.filesystem, getStats: vi.fn() },
  };
});

const result = (exitCode = 0, stdErr = "", stdOut = ""): ProcessResult => ({
  exitCode,
  stdErr,
  stdOut,
});
const proxy = "http://127.0.0.1:7890";

function fixture(kind: "http" | "hls" = "http") {
  const task = createDownloadTasks(
    {
      urls: [`https://example.test/video.${kind === "http" ? "mp4" : "m3u8"}`],
      directory: "E:/test-downloads",
      headers: { Referer: "https://example.test/" },
      kind,
    },
    [],
  )[0]!;
  const data = new Map<string, string>();
  const directory = task.workDirectory;
  const writeHttp = (
    bytes = "video",
    headers = 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nETag: "v1"\r\n\r\n',
  ) => {
    data.set(`${directory}/download.part`, bytes);
    data.set(`${directory}/response.headers`, headers);
  };
  let download: ProcessRunner = async () => {
    writeHttp();
    return result();
  };
  let mergeResult = result();
  const run = vi.fn<ProcessRunner>(async (file, args, signal, output) => {
    if (file === "ffmpeg") {
      data.set(args.at(-1)!, "video");
      return mergeResult;
    }
    return download(file, args, signal, output);
  });
  const host: DownloadHost = {
    run,
    probe: async () => ({
      video: true,
      audio: false,
      videoTracks: 1,
      audioTracks: 0,
      durationMs: 10000,
      width: 320,
      height: 180,
      audioChannels: 0,
      audioLanguage: "",
    }),
    tool: async (name) => name,
    defaultDirectory: async () => "E:/test-downloads",
    open: async () => {},
    files: {
      mkdir: async () => {},
      stat: async (path) =>
        data.has(path) ? { size: data.get(path)!.length, isFile: true } : null,
      read: async (path) => {
        if (!data.has(path)) throw new Error("file missing");
        return data.get(path)!;
      },
      write: async (path, value) => {
        data.set(path, value);
      },
      list: async (path) => [...data.keys()].filter((file) => file.startsWith(`${path}/`)),
      move: async (from, to) => {
        data.set(to, data.get(from)!);
        data.delete(from);
      },
      remove: async (path) => {
        for (const file of data.keys())
          if (file === path || file.startsWith(`${path}/`)) data.delete(file);
      },
    },
  };
  const getProxy = vi.fn(async () => proxy);
  const controller = new AbortController();
  const progress = vi.fn();
  const stage = vi.fn(async () => {});
  return {
    task,
    data,
    host,
    run,
    getProxy,
    controller,
    progress,
    stage,
    writeHttp,
    setDownload: (value: ProcessRunner) => {
      download = value;
    },
    setMerge: (value: ProcessResult) => {
      mergeResult = value;
    },
    start: () =>
      new ToolDownloadEngine(host, getProxy).run(
        task,
        defaultDownloadSettings,
        controller.signal,
        progress,
        stage,
      ),
  };
}

describe("download output validation", () => {
  it.each([
    [{ video: false }, "缺少视频轨道"],
    [{ audio: false }, "缺少音频轨道"],
    [{ durationMs: 5000 }, "时长不完整"],
  ])(
    "preserves inputs when MediaInfo reports an invalid merged output: %s",
    async (changes, message) => {
      const f = fixture();
      const valid = {
        ...(await f.host.probe("fixture", f.controller.signal)),
        audio: true,
        audioTracks: 1,
      };
      let probes = 0;
      f.host.probe = async () => (++probes === 1 ? valid : { ...valid, ...changes });
      await expect(f.start()).rejects.toThrow(message);
      expect(f.data.has(f.task.output)).toBe(false);
      expect(f.data.has(`${f.task.workDirectory}/download.part`)).toBe(true);
    },
  );
});

describe("download direct-first proxy fallback", () => {
  it("does not resolve or contact the proxy when direct HTTP succeeds", async () => {
    const f = fixture();
    let config = "";
    f.setDownload(async () => {
      config = f.data.get(`${f.task.workDirectory}/request.curl`)!;
      f.writeHttp();
      return result();
    });
    await f.start();
    expect(config).toContain('proxy = ""\nnoproxy = "*"');
    expect(f.getProxy).not.toHaveBeenCalled();
    expect(f.data.has(f.task.output)).toBe(true);
  });
  it("retries HTTP exactly once through the shared proxy, preserving range validators and headers", async () => {
    const f = fixture();
    const configs: string[] = [];
    f.setDownload(async () => {
      configs.push(f.data.get(`${f.task.workDirectory}/request.curl`)!);
      if (configs.length === 1) {
        f.writeHttp("vi");
        return result(18, "transfer closed");
      }
      f.writeHttp(
        "video",
        'HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-4/5\r\nETag: "v1"\r\n\r\n',
      );
      return result();
    });
    await f.start();
    expect(configs).toHaveLength(2);
    expect(configs[1]).toContain(`proxy = "${proxy}"\nnoproxy = ""`);
    expect(configs[1]).toContain('If-Range: \\"v1\\"');
    expect(configs[1]).toContain("Referer: https://example.test/");
    expect(f.progress).toHaveBeenCalledWith(
      expect.objectContaining({ line: "直连失败，正在通过网络代理重试。" }),
    );
    expect(f.data.has(f.task.output)).toBe(true);
  });
  it("reports a failed proxy attempt without looping or merging", async () => {
    const f = fixture();
    const transfer = vi.fn(async () => result(22, "HTTP 403"));
    f.setDownload(transfer);
    await expect(f.start()).rejects.toThrow("代理下载失败");
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(f.stage).not.toHaveBeenCalledWith("merge", expect.anything());
    expect(f.data.has(f.task.output)).toBe(false);
  });
  it("leaves the direct failure visible when no proxy is enabled", async () => {
    const f = fixture();
    f.getProxy.mockResolvedValue("");
    const transfer = vi.fn(async () => result(6, "Could not resolve host"));
    f.setDownload(transfer);
    await expect(f.start()).rejects.toThrow("直连下载失败");
    expect(transfer).toHaveBeenCalledTimes(1);
  });
  it.each([23, 26, 33, 48])(
    "does not retry local/resume/configuration curl failure %s",
    async (code) => {
      const f = fixture();
      f.setDownload(async () => result(code, "local failure"));
      await expect(f.start()).rejects.toThrow();
      expect(f.getProxy).not.toHaveBeenCalled();
    },
  );
  it("does not retry a failed MP4 merge through the proxy", async () => {
    const f = fixture();
    f.setMerge(result(1, "disk full"));
    await expect(f.start()).rejects.toThrow("合并失败");
    expect(f.getProxy).not.toHaveBeenCalled();
    expect(f.data.has(`${f.task.workDirectory}/download.part`)).toBe(true);
  });
  it("keeps a rejected HTTP range as a resume error without switching proxy", async () => {
    const f = fixture();
    f.setDownload(async () => {
      f.writeHttp(
        "video",
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */5\r\n\r\n",
      );
      return result(22);
    });
    await expect(f.start()).rejects.toThrow("续传");
    expect(f.getProxy).not.toHaveBeenCalled();
  });
  it("never switches route after cancellation, even while resolving the proxy", async () => {
    const f = fixture();
    const transfer = vi.fn(async () => result(7));
    f.setDownload(transfer);
    f.getProxy.mockImplementation(async () => {
      f.controller.abort();
      return proxy;
    });
    await expect(f.start()).rejects.toMatchObject({ name: "AbortError" });
    expect(transfer).toHaveBeenCalledTimes(1);
  });
  /** 模拟 curl：按生成的配置写出播放列表或分片，并像真实进程那样逐行报告分片结果。 */
  const hlsCurl =
    (
      f: ReturnType<typeof fixture>,
      decide: (kind: "playlist" | "segments", config: string) => ProcessResult | number | void,
    ): ProcessRunner =>
    async (_file, args, _signal, output) => {
      const config = f.data.get(args[args.indexOf("--config") + 1]!)!;
      const outputs = [...config.matchAll(/^output = "(.*)"$/gm)].map((match) => match[1]!);
      const kind = outputs[0]!.endsWith("fetch.m3u8") ? "playlist" : "segments";
      const decision = decide(kind, config);
      if (typeof decision === "object") return decision;
      const failure = typeof decision === "number" ? decision : 0;
      if (kind === "playlist") {
        if (failure) return result(failure, `curl: (${failure}) failed`);
        f.data.set(
          outputs[0]!,
          "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST\n",
        );
        return result(0, "", f.task.url);
      }
      for (const path of outputs) {
        if (!failure) f.data.set(path, "segment-bytes");
        output?.(
          `javm-transfer\t${failure}\t${failure ? 0 : 200}\t${failure ? 0 : 13}\tvideo/mp2t\t${path}\n`,
          "stderr",
        );
      }
      return result(failure);
    };
  it("disables system proxy for HLS and uses the configured proxy only after a network failure", async () => {
    const f = fixture("hls");
    const playlists: string[] = [];
    f.setDownload(
      hlsCurl(f, (kind, config) => {
        if (kind === "playlist") playlists.push(config);
        if (kind === "playlist" && playlists.length === 1) return 7;
      }),
    );
    await f.start();
    expect(playlists).toHaveLength(2);
    expect(playlists[0]).toContain('proxy = ""\nnoproxy = "*"');
    expect(playlists[1]).toContain(`proxy = "${proxy}"\nnoproxy = ""`);
    expect(playlists[1]).toContain("Referer: https://example.test/");
    expect(f.getProxy).toHaveBeenCalledTimes(1);
    expect(f.data.has(f.task.output)).toBe(true);
  });
  it.each([
    ["segment disk write failure", 23],
    ["invalid local output path", 26],
  ])("does not retry HLS %s through the proxy", async (_name, code) => {
    const f = fixture("hls");
    f.setDownload(hlsCurl(f, (kind) => (kind === "segments" ? code : undefined)));
    await expect(f.start()).rejects.toThrow("直连下载失败");
    expect(f.getProxy).not.toHaveBeenCalled();
    expect(f.data.has(f.task.output)).toBe(false);
  });
  it("does not retry an invalid playlist through the proxy", async () => {
    const f = fixture("hls");
    f.setDownload(async (_file, args) => {
      const config = f.data.get(args[args.indexOf("--config") + 1]!)!;
      f.data.set(/^output = "(.*)"$/m.exec(config)![1]!, "<html>not a playlist</html>");
      return result(0, "", f.task.url);
    });
    await expect(f.start()).rejects.toThrow("不是 HLS");
    expect(f.getProxy).not.toHaveBeenCalled();
  });
  it("retries HLS segments through the proxy after a transport reset and keeps finished ones", async () => {
    const f = fixture("hls");
    const segmentConfigs: string[] = [];
    f.setDownload(
      hlsCurl(f, (kind, config) => {
        if (kind !== "segments") return;
        segmentConfigs.push(config);
        if (segmentConfigs.length === 1) return 56;
      }),
    );
    await f.start();
    expect(f.getProxy).toHaveBeenCalledTimes(1);
    expect(segmentConfigs).toHaveLength(2);
    expect(segmentConfigs[1]).toContain(`proxy = "${proxy}"`);
    expect(f.data.has(f.task.output)).toBe(true);
  });
  it("redacts authenticated proxy URLs from persisted/displayed logs", () => {
    const f = fixture();
    expect(redactLog("proxy socks5://user:secret@localhost:1080 failed", f.task)).toBe(
      "proxy [地址] failed",
    );
  });
});

describe("shared network settings", () => {
  it("persists a valid proxy and exposes it only while enabled", async () => {
    const write = vi.fn(async () => {});
    const service = new NetworkSettingsService({ read: async () => null, write });
    await service.update({ proxyEnabled: true, proxy });
    expect(await service.getProxy()).toBe(proxy);
    await service.update({ proxyEnabled: false, proxy });
    expect(await service.getProxy()).toBe("");
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("loads once and preserves an explicitly disabled global choice over legacy downloads", async () => {
    const read = vi.fn(async () => ({ proxyEnabled: false, proxy }));
    const write = vi.fn(async () => {});
    const service = new NetworkSettingsService({ read, write });
    await Promise.all([
      service.initialize(),
      service.initialize(),
      service.importLegacyProxy(proxy),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(await service.getProxy()).toBe("");
  });
  it("imports an existing download proxy only into unsaved global settings", async () => {
    const write = vi.fn(async () => {});
    const service = new NetworkSettingsService({ read: async () => null, write });
    await service.importLegacyProxy(proxy);
    expect(await service.getProxy()).toBe(proxy);
    await service.importLegacyProxy("http://localhost:1234");
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("does not claim that failed persistence was saved", async () => {
    const service = new NetworkSettingsService({
      read: async () => null,
      write: async () => {
        throw new Error("disk full");
      },
    });
    await expect(service.update({ proxyEnabled: true, proxy })).rejects.toThrow("disk full");
    expect(await service.getProxy()).toBe("");
  });
  it("reports unreadable storage without overwriting it through legacy migration", async () => {
    const write = vi.fn(async () => {});
    const service = new NetworkSettingsService({
      read: async () => {
        throw new Error("read failed");
      },
      write,
    });
    await service.importLegacyProxy(proxy);
    await expect(service.getProxy()).rejects.toThrow("无法读取网络设置");
    expect(write).not.toHaveBeenCalled();
    await service.update({ proxyEnabled: false, proxy: "" });
    expect(await service.getProxy()).toBe("");
  });
  it.each([
    "",
    "ftp://localhost:21",
    "http://localhost/path",
    "http://localhost?token=x",
    "http://localhost\nproxy = x",
  ])("rejects invalid proxy %j", (value) => {
    expect(() => validateNetworkSettings({ proxyEnabled: true, proxy: value })).toThrow(
      "请输入有效",
    );
  });
});

describe("Neutralino network settings adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { NL_DATAPATH: "E:/isolated-settings-test" });
    vi.mocked(storage.getKeys).mockResolvedValue([]);
    vi.mocked(storage.getData).mockResolvedValue("{}");
    vi.mocked(storage.setData).mockResolvedValue(undefined);
    vi.mocked(filesystem.getStats).mockRejectedValue({ code: "NE_FS_NOPATHE" });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it("starts with defaults when the native storage directory has not been created", async () => {
    vi.mocked(storage.getKeys).mockRejectedValue({ code: "NE_ST_NOSTDIR" });
    const service = createNetworkSettings("desktop");
    expect(await service.getProxy()).toBe("");
    expect(service.getSnapshot().error).toBe("");
    expect(storage.setData).not.toHaveBeenCalled();
  });
  it("does not treat unreadable native storage as an absent configuration", async () => {
    vi.mocked(storage.getKeys).mockRejectedValue({ code: "NE_ST_NOSTDIR" });
    vi.mocked(filesystem.getStats).mockRejectedValue({ code: "NE_FS_FILRDER" });
    const service = createNetworkSettings("desktop");
    await expect(service.getProxy()).rejects.toThrow("无法读取网络设置");
    expect(storage.setData).not.toHaveBeenCalled();
  });
  it("saves through the official storage API and reloads the shared proxy", async () => {
    const settings = { proxyEnabled: true, proxy };
    const service = createNetworkSettings("desktop");
    await service.update(settings);
    expect(storage.setData).toHaveBeenCalledWith("javm-network-v1", JSON.stringify(settings));
    vi.mocked(storage.getKeys).mockResolvedValue(["javm-network-v1"]);
    vi.mocked(storage.getData).mockResolvedValue(JSON.stringify(settings));
    expect(await createNetworkSettings("desktop").getProxy()).toBe(proxy);
  });
});
