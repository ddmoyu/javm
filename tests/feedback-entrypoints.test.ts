import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FeedbackService } from "../frontend/src/services/feedback/FeedbackService";
import { setFailureSink } from "../frontend/src/services/feedback/events";
import { LogService } from "../frontend/src/services/logging/LogService";
import { setLogSink } from "../frontend/src/services/logging/events";
import { observeLogState } from "../frontend/src/services/logging/observe";
import { OnlineActorSearchService } from "../frontend/src/services/catalog/OnlineActorSearchService";
import { OnlineWorksService } from "../frontend/src/services/catalog/OnlineWorksService";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";
import { ArtworkService } from "../frontend/src/services/library/ArtworkService";
import type { ArtworkTools } from "../frontend/src/services/library/ArtworkService";
import { AutoCoverService } from "../frontend/src/services/library/AutoCoverService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import type { DownloadRepository, DownloadEngine } from "../frontend/src/services/downloads/ports";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type { DownloadTask } from "../frontend/src/contracts/downloads";
import { MagnetSearchService } from "../frontend/src/services/magnets/MagnetSearchService";
import { normalizeMagnet } from "../frontend/src/services/magnets/magnet";
import { PlayerWindowController } from "../frontend/src/services/playback/PlayerWindowController";
import type { PlayerWindowMessage } from "../frontend/src/services/playback/windowChannel";
import { playerChannelName } from "../frontend/src/services/playback/windowChannel";
import { SystemIntegrationService } from "../frontend/src/platform/neutralino/systemIntegration";
import { filesystem, os } from "@neutralinojs/lib";

vi.mock("@neutralinojs/lib", () => ({
  filesystem: { getStats: vi.fn() },
  os: { execCommand: vi.fn() },
}));
vi.mock("../frontend/src/platform/neutralino/library", () => ({ NativeLibraryPort: class {} }));
let feedback: FeedbackService;
beforeEach(async () => {
  vi.useFakeTimers();
  const logs = new LogService();
  feedback = new FeedbackService(logs, {
    read: async () => null,
    write: async () => {},
    system: async () => ({ 操作系统: "Safe OS" }),
    copy: async () => {},
    open: async () => {},
  });
  setLogSink(logs.record);
  setFailureSink(feedback.capture);
  await feedback.initialize();
});
afterEach(() => {
  feedback.dispose();
  setFailureSink();
  setLogSink();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const reports = () => feedback.getSnapshot().reports;
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const aborted = (_url: string, signal: AbortSignal) =>
  new Promise<string>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
const processor = (result: unknown = { items: [], nextPage: null }): CatalogProcessor => ({
  run: vi.fn(async () => result) as CatalogProcessor["run"],
  close() {},
});
const safeLink = "https://media.example.invalid/safe.m3u8?token=safe-full-value";
function downloadFixture(initial: DownloadTask[] = [], failSave = false) {
  const repository: DownloadRepository = {
    load: async () => ({
      tasks: initial,
      settings: { ...defaultDownloadSettings, directory: "E:/safe-fixtures" },
    }),
    save: async (task) => {
      if (failSave && task.status === "failed") throw new Error("模拟数据库不可写");
    },
    remove: async () => {},
    saveSettings: async () => {},
    close: async () => {},
  };
  const engine: DownloadEngine = {
    defaultDirectory: async () => "E:/safe-fixtures",
    outputSize: async () => null,
    checkTools: async () => [],
    open: async () => {},
    run: async () => {
      throw new Error("安全模拟缺少 2 个分片");
    },
  };
  return new DownloadService(repository, engine);
}
function artwork() {
  const request: LibraryPort["request"] = async <T>() =>
    ({
      directory: "E:/safe-fixtures",
      poster: "",
      code: "SAFE-001",
      title: "安全样例",
      videos: [],
      source: {},
    }) as T;
  const tools: ArtworkTools = {
    mkdir: async () => {},
    read: async () => new ArrayBuffer(4),
    write: async () => {},
    remove: async () => {},
    frame: async () => {},
    transform: async () => new ArrayBuffer(4),
    download: async () => {},
    details: async () => ({ fields: {}, homepage: "", provider: "fixture", id: "safe" }),
  };
  const service = new ArtworkService({ request }, tools, async () => {});
  return { service, tools };
}
class Channel {
  static all = new Set<Channel>();
  onmessage?: (event: { data: PlayerWindowMessage }) => void;
  constructor(readonly name: string) {
    Channel.all.add(this);
  }
  postMessage(data: PlayerWindowMessage) {
    for (const other of Channel.all)
      if (other !== this && other.name === this.name)
        queueMicrotask(() => {
          if (Channel.all.has(other)) other.onmessage?.({ data });
        });
  }
  close() {
    Channel.all.delete(this);
  }
}

describe("关键功能真实服务的反馈入口（安全 mock）", () => {
  it("下载最终失败遇到状态写库失败，仍保留原始错误、任务及完整链接", async () => {
    const service = downloadFixture([], true);
    await service.initialize();
    await service.add({
      urls: [safeLink],
      kind: "hls",
      directory: "E:/safe-fixtures",
      headers: {},
    });
    await flush();
    const report = reports().find((item) => item.url === safeLink)!;
    expect(report.message).toContain("缺少 2 个分片");
    expect(report.taskId).toBeTruthy();
    expect(report.before).toContain("缺少 2 个分片");
    expect(service.getSnapshot().error).toContain("数据库不可写");
    await service.shutdown();
  });
  it("下载完成后刮削交接失败保留下载身份和链接", async () => {
    const task = createDownloadTasks(
      {
        urls: [safeLink],
        kind: "hls",
        directory: "E:/safe-fixtures",
        headers: {},
      },
      [],
    )[0]!;
    const service = downloadFixture([{ ...task, status: "completed", scrapeAfterDownload: true }]);
    service.connectScraping(async () => {
      throw new Error("安全模拟刮削队列已满");
    });
    await service.initialize();
    await flush();
    expect(
      reports().some((item) => item.url === safeLink && item.message.includes("队列已满")),
    ).toBe(true);
    await service.shutdown();
  });
  it("在线搜索部分来源失败会反馈，空结果不反馈", async () => {
    const service = new OnlineActorSearchService(processor(), async (url) => {
      if (url.includes("uncensored")) throw new Error("安全模拟来源失败");
      return "safe";
    });
    service.search("安全样例");
    await flush();
    expect(reports()[0]?.message).toContain("来源失败");
    await service.shutdown();
    const empty = new OnlineActorSearchService(processor(), async () => "safe");
    empty.search("安全空结果");
    await flush();
    expect(reports()).toHaveLength(1);
    await empty.shutdown();
  });
  it("在线搜索超时会反馈，关闭或替换搜索不反馈", async () => {
    const service = new OnlineActorSearchService(processor(), aborted);
    service.search("安全样例");
    await flush();
    service.cancel();
    await flush();
    expect(reports()).toHaveLength(0);
    service.search("安全超时样例");
    await flush();
    await vi.advanceTimersByTimeAsync(60001);
    expect(reports()[0]?.message).toContain("超时");
    await service.shutdown();
  });
  it("在线作品页及详情失败均反馈，未匹配条目与主动关闭不反馈", async () => {
    const entity = { id: "star:safe", name: "安全示例", url: "https://www.javbus.com/star/safe" };
    const work = { code: "SAFE-001", title: "安全样例", url: "https://www.javbus.com/SAFE-001" };
    const worker = processor();
    worker.run = (async (operation: string) => {
      if (operation === "javbusPlan") return { entities: [entity], queries: [], names: [] };
      if (operation === "javbusWorks") return { items: [work], page: 1, nextPage: null };
      throw new Error("安全详情解析失败");
    }) as CatalogProcessor["run"];
    let failPage = true;
    const service = new OnlineWorksService(
      worker,
      async () => {
        if (failPage) throw new Error("安全作品页失败");
        return "safe";
      },
      async () => {},
    );
    service.select("actresses", "安全示例");
    await flush();
    expect(reports()[0]?.message).toContain("作品页失败");
    failPage = false;
    service.retry();
    await flush();
    service.open(work);
    await flush();
    expect(
      reports().some(
        (item) => item.details?.action === "work_detail" && item.message.includes("详情解析失败"),
      ),
    ).toBe(true);
    await service.shutdown();
    const empty = new OnlineWorksService(
      processor({ entities: [], queries: [], names: [] }),
      async () => "safe",
      async () => {},
    );
    empty.select("genres", "安全无结果");
    await flush();
    expect(reports()).toHaveLength(2);
    await empty.shutdown();
    const stopped = new OnlineWorksService(worker, aborted, async () => {});
    stopped.select("actresses", "安全关闭");
    await flush();
    stopped.cancel();
    await flush();
    expect(reports()).toHaveLength(2);
    await stopped.shutdown();
  });
  it("自动封面单项失败在完成后汇总一次，并保留有界原因", async () => {
    const request: LibraryPort["request"] = async <T>(method: string) =>
      (method.endsWith("pending")
        ? Array.from({ length: 5 }, (_, i) => ({
            id: `safe-${i}`,
            video_id: `v-${i}`,
            path: `E:/safe-fixtures/${i}.mp4`,
            file_stamp: "fixture",
            duration_ms: 60000,
          }))
        : method.endsWith("prepare")
          ? { directory: "E:/safe-fixtures", poster: "" }
          : {}) as T;
    const tools = artwork().tools;
    tools.frame = async () => {
      throw new Error("安全模拟无法抽帧");
    };
    const service = new AutoCoverService({ request }, tools, async () => {});
    const unobserve = observeLogState("artwork", service, (value) => ({
      state: value.running ? "运行中" : "结束",
      error: value.error,
    }));
    service.schedule();
    await flush();
    await flush();
    expect(service.getSnapshot()).toMatchObject({ running: false, failed: 5 });
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.message).toContain("5 项失败");
    expect(reports()[0]?.message.match(/无法抽帧/g)).toHaveLength(3);
    unobserve();
    await service.shutdown();
  });
  it.each(["timeout", "cancel", "cleanup"] as const)(
    "图片任务 %s 区分真正失败和主动取消",
    async (mode) => {
      const f = artwork();
      f.tools.transform = (_buffers, _sheet, _crop, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () =>
              reject(mode === "cleanup" ? new StopUnconfirmedError(async () => {}) : signal.reason),
            { once: true },
          ),
        );
      const done = f.service.cover("safe", "E:/safe-fixtures/safe.png").catch(() => {});
      await flush();
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(600001);
      else f.service.cancel();
      await done;
      if (mode === "cancel") expect(reports()).toHaveLength(0);
      else {
        expect(reports()).toHaveLength(1);
        expect(reports()[0]?.message).toContain(mode === "timeout" ? "10 分钟" : "未能确认");
      }
      await f.service.shutdown();
    },
  );
  it("图片处理部分成功的清理警告也提供反馈入口", async () => {
    const f = artwork();
    f.tools.remove = async () => {
      throw new Error("安全模拟文件占用");
    };
    await f.service.cover("safe", "E:/safe-fixtures/safe.png");
    expect(reports()[0]?.message).toContain("清理失败");
    await f.service.shutdown();
  });
  it("磁力交给下载器失败，以及清理失败与重试失败均反馈", async () => {
    const magnet = {
      ...normalizeMagnet(`magnet:?xt=urn:btih:${"01".repeat(20)}`)!,
      title: "安全样例",
      sources: ["btdig" as const],
    };
    let broken = false,
      cleanupFail = true;
    const retry = async () => {
      if (cleanupFail) throw new Error("安全模拟清理失败");
    };
    const service = new MagnetSearchService({
      merge: async (_existing, incoming) => [...incoming],
      search: async () => {
        if (broken) throw new StopUnconfirmedError(retry);
        return { rows: [magnet], hasMore: false };
      },
      open: async () => {
        throw new Error("安全模拟无关联程序");
      },
      close() {},
    });
    service.search("SAFE-001");
    await flush();
    await expect(service.openResult(magnet.id)).rejects.toThrow("下载器");
    expect(reports()[0]?.details?.action).toBe("open_downloader");
    broken = true;
    service.search("SAFE-002");
    await flush();
    expect(reports().some((item) => item.details?.action === "search_cleanup")).toBe(true);
    await expect(service.retryCleanup()).rejects.toThrow("清理");
    expect(reports().some((item) => item.details?.action === "retry_cleanup")).toBe(true);
    cleanupFail = false;
    await service.shutdown();
  });
  it.each([false, true])("播放器正常关闭/心跳断开（异常=%s）仅失联时反馈", async (abnormal) => {
    vi.stubGlobal("BroadcastChannel", Channel);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let child!: Channel;
    const service = new PlayerWindowController(async (id) => {
      child = new Channel(playerChannelName(id));
      child.onmessage = ({ data }) => {
        if (data.type === "command") child.postMessage({ type: "result", id: data.id });
      };
      child.postMessage({ type: "ready" });
    });
    await service.play(safeLink);
    if (!abnormal) {
      child.postMessage({ type: "closed" });
      await flush();
    }
    child.close();
    await vi.advanceTimersByTimeAsync(125001);
    expect(reports()).toHaveLength(abnormal ? 1 : 0);
    if (abnormal) {
      expect(reports()[0]?.message).toContain("未响应");
      expect(reports()[0]?.details?.windowId).toBeTruthy();
    }
    await service.shutdown();
    Channel.all.clear();
  });
  it("播放器启动失败在会话移除前反馈", async () => {
    vi.stubGlobal("BroadcastChannel", Channel);
    const service = new PlayerWindowController(async () => {
      throw new Error("安全模拟窗口创建失败");
    });
    await expect(service.play(safeLink)).rejects.toThrow("窗口创建失败");
    expect(reports()[0]?.message).toContain("窗口创建失败");
    await service.shutdown();
    Channel.all.clear();
  });
  it("Windows 协议注册失败生成含操作名称的反馈", async () => {
    vi.stubGlobal("window", { NL_OS: "Windows", NL_PATH: "E:/safe-fixtures" });
    vi.mocked(filesystem.getStats).mockResolvedValue({ isFile: true } as Awaited<
      ReturnType<typeof filesystem.getStats>
    >);
    vi.mocked(os.execCommand).mockResolvedValue({
      stdOut: JSON.stringify({ error: "安全模拟注册被拒绝" }),
      stdErr: "",
      exitCode: 1,
      pid: 0,
    });
    const service = new SystemIntegrationService("desktop");
    await service.run("register");
    expect(reports()[0]?.message).toContain("注册被拒绝");
    expect(reports()[0]?.details?.action).toBe("register");
  });
});
