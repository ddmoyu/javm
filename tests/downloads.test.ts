import { describe, expect, it, vi } from "vite-plus/test";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type {
  DownloadSettings,
  DownloadTask,
  NewDownload,
} from "../frontend/src/contracts/downloads";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import {
  createDownloadTasks,
  normalizeDownloadUrl,
  parseHeaders,
  redactLog,
  safeName,
} from "../frontend/src/services/downloads/input";
import type {
  DownloadEngine,
  DownloadProgress,
  DownloadRepository,
} from "../frontend/src/services/downloads/ports";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { responseInfo } from "../frontend/src/services/downloads/http";
import { keepTextTail } from "../frontend/src/services/downloads/text";
import {
  byteValue,
  formatDownloadSize,
  OutputLines,
  parseCurlProgress,
} from "../frontend/src/services/downloads/progress";
import { processCommand, quoteWindowsArgument } from "../frontend/src/platform/neutralino/process";

class MemoryRepository implements DownloadRepository {
  tasks: DownloadTask[] = [];
  settings = { ...defaultDownloadSettings, directory: "E:/test-downloads", concurrency: 1 };
  closed = false;
  async load() {
    return structuredClone({ tasks: this.tasks, settings: this.settings });
  }
  async save(task: DownloadTask, expected: number) {
    const existing = this.tasks.find((item) => item.id === task.id);
    if ((existing?.revision ?? 0) !== expected) throw new Error("revision conflict");
    this.tasks = [...this.tasks.filter((item) => item.id !== task.id), structuredClone(task)];
  }
  async remove(id: string) {
    this.tasks = this.tasks.filter((item) => item.id !== id);
  }
  async saveSettings(settings: DownloadSettings) {
    this.settings = settings;
  }
  async close() {
    this.closed = true;
  }
}
class ControlledEngine implements DownloadEngine {
  calls: {
    task: DownloadTask;
    signal: AbortSignal;
    progress: (update: DownloadProgress) => void;
    stage: (phase: DownloadTask["phase"], inputs?: string[]) => Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  async defaultDirectory() {
    return "E:/test-downloads";
  }
  async outputSize(): Promise<number | null> {
    return null;
  }
  async checkTools() {
    return [];
  }
  async open() {}
  async run(
    task: DownloadTask,
    _: DownloadSettings,
    signal: AbortSignal,
    progress: (update: DownloadProgress) => void,
    stage: (phase: DownloadTask["phase"], inputs?: string[]) => Promise<void>,
  ) {
    await stage(task.phase);
    await new Promise<void>((resolve, reject) => {
      const call = { task, signal, progress, stage, resolve, reject };
      this.calls.push(call);
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
      if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
    });
  }
}
const input = (urls = ["https://example.com/a.mp4"]): NewDownload => ({
  urls,
  directory: "E:/test-downloads",
  kind: "auto",
  headers: {},
});

describe("download input and process boundary", () => {
  it("preserves signed URL parameters but excludes fragments and invalid schemes", () => {
    expect(normalizeDownloadUrl("https://example.com/v.mp4?token=123#x")).toBe(
      "https://example.com/v.mp4?token=123",
    );
    for (const url of [
      "magnet:?xt=urn:btih:x",
      "file:///C:/data",
      "https://user:password@example.com/a",
    ])
      expect(() => normalizeDownloadUrl(url)).toThrow();
  });
  it("isolates output directories and sanitizes Windows names", () => {
    expect(safeName("../../CON.mp4")).not.toContain("..");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    const tasks = createDownloadTasks(
      input(["https://example.com/a.m3u8", "https://example.com/b.mp4"]),
      [],
    );
    expect(tasks.map((task) => task.kind)).toEqual(["hls", "http"]);
    expect(tasks[0]!.directory).not.toBe(tasks[1]!.directory);
    expect(() => createDownloadTasks(input(), createDownloadTasks(input(), []))).toThrow(
      "相同链接",
    );
  });
  it("validates headers and removes URL tokens and credentials from logs", () => {
    expect(parseHeaders("Referer: https://example.com/\nCookie: session=abc")).toEqual({
      Referer: "https://example.com/",
      Cookie: "session=abc",
    });
    expect(() => parseHeaders("Range: bytes=1-")).toThrow();
    expect(() => parseHeaders("broken")).toThrow();
    expect(() =>
      createDownloadTasks({ ...input(), headers: { Cookie: "a\nRange: bytes=1-" } }, []),
    ).toThrow();
    const task = { url: "https://example.com/v?secret=x", headers: { Cookie: "session=abc" } };
    expect(redactLog(`failed ${task.url} session=abc`, task)).not.toMatch(/secret|session=abc/);
  });
  it("keeps shell metacharacters in literal process arguments", () => {
    const payload = "https://example.com/a?x=%PATH%&y=$(whoami);'中文";
    const command = processCommand("C:/Tools/ffmpeg.exe", [payload, 'a"b', "C:\\end\\"]);
    expect(command).not.toContain(payload);
    const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("$p.UseShellExecute=$false");
    expect(script).toContain(";''中文");
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArgument("C:\\end\\")).toBe('"C:\\end\\\\"');
  });
});

describe("real tool output parsing", () => {
  it("bounds Unicode logs without splitting a surrogate pair", () => {
    expect(keepTextTail("前😀abc", 4)).toBe("abc");
    expect(keepTextTail("前😀abc", 5)).toBe("😀abc");
    expect(keepTextTail("前😀abc", 0)).toBe("");
    expect(
      redactLog("😀" + "x".repeat(1499), { url: "https://example.com/video", headers: {} }),
    ).toBe("x".repeat(1499));
    const output = new OutputLines();
    output.push("😀" + "x".repeat(8191));
    expect(output.finish()[0]).toBe("x".repeat(8191));
  });
  it("distinguishes estimates, unknown totals and output size", () => {
    const task = createDownloadTasks(input(), [])[0]!;
    expect(formatDownloadSize(task)).toBe("大小未知");
    expect(formatDownloadSize({ ...task, downloaded: 1024 })).toBe("1.0 KB / 总大小未知");
    expect(
      formatDownloadSize({ ...task, downloaded: 1024, total: 2048, totalIsEstimate: true }),
    ).toBe("1.0 KB / 约 2.0 KB");
    expect(
      formatDownloadSize({ ...task, status: "completed", total: 2048, outputSize: 1500 }),
    ).toBe("1.5 KB");
  });
  it("uses the final response and prefers a strong ETag for safe resume", () => {
    expect(
      responseInfo(
        'HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\nHTTP/2 206 Partial Content\r\nETag: "v1"\r\nLast-Modified: yesterday\r\nContent-Length: 50\r\nContent-Range: bytes 50-99/100\r\n\r\n',
      ),
    ).toEqual({ status: 206, total: 100, validator: '"v1"' });
  });
  it("handles split stdout, carriage-return updates and ANSI escapes", () => {
    const parser = new OutputLines();
    expect(parser.push("\x1b[32mVid 1/")).toEqual([]);
    expect(parser.push("2 50%\x1b[0m\rnext\nlast")).toEqual(["Vid 1/2 50%", "next"]);
    expect(parser.finish()).toEqual(["last"]);
  });
  it("reads curl progress", () => {
    expect(byteValue("100")).toBe(100);
    expect(byteValue("1.5M")).toBe(1572864);
    expect(
      parseCurlProgress("50 1024k 50 512k 0 0 256k 0 0:00:04 0:00:02 0:00:02 255k"),
    ).toMatchObject({ progress: 50, downloaded: 524288 });
  });
});

describe("application download queue", () => {
  it("runs tasks concurrently, applies new limits and coalesces all progress into one UI update", async () => {
    const repo = new MemoryRepository();
    repo.settings.concurrency = 2;
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    await service.initialize();
    await service.add(
      input([
        "https://example.com/a.mp4",
        "https://example.com/b.mp4",
        "https://example.com/c.mp4",
        "https://example.com/d.mp4",
      ]),
    );
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    const controls = service.getControls();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    for (let progress = 1; progress <= 100; progress++) {
      engine.calls[0]!.progress({ progress, downloaded: progress * 10, total: 2000 });
      engine.calls[1]!.progress({ progress, downloaded: progress * 20, total: 4000 });
    }
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(service.getControls()).toBe(controls);
    expect(
      service
        .getSnapshot()
        .tasks.slice(0, 2)
        .map((task) => task.downloaded),
    ).toEqual([1000, 2000]);
    unsubscribe();
    await service.updateSettings({ ...repo.settings, concurrency: 3 });
    await vi.waitFor(() => expect(engine.calls).toHaveLength(3));
    await service.updateSettings({ ...repo.settings, concurrency: 1 });
    engine.calls[0]!.resolve();
    engine.calls[1]!.resolve();
    await vi.waitFor(() =>
      expect(
        service.getSnapshot().tasks.filter((task) => task.status === "completed"),
      ).toHaveLength(2),
    );
    expect(engine.calls).toHaveLength(3);
    engine.calls[2]!.resolve();
    await vi.waitFor(() => expect(engine.calls).toHaveLength(4));
    await service.shutdown();
  });
  it("does not roll progress back after a slow SQLite save", async () => {
    vi.useFakeTimers();
    const repo = new MemoryRepository();
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    try {
      await service.initialize();
      await service.add(input());
      await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(2100);
      const save = repo.save.bind(repo);
      let finishSave!: () => void;
      repo.save = async (task, revision) => {
        await new Promise<void>((resolve) => {
          finishSave = resolve;
        });
        await save(task, revision);
      };
      engine.calls[0]!.progress({ progress: 30, downloaded: 300 });
      await vi.advanceTimersByTimeAsync(200);
      engine.calls[0]!.progress({ progress: 60, downloaded: 600 });
      await vi.advanceTimersByTimeAsync(200);
      repo.save = save;
      finishSave();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getSnapshot().tasks[0]).toMatchObject({ progress: 60, downloaded: 600 });
      await service.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
  it("fills old completed file sizes asynchronously without delaying readiness or new work", async () => {
    const repo = new MemoryRepository();
    repo.tasks = [{ ...createDownloadTasks(input(), [])[0]!, status: "completed", revision: 1 }];
    const engine = new ControlledEngine();
    let foundSize!: (size: number) => void;
    engine.outputSize = () =>
      new Promise<number>((resolve) => {
        foundSize = resolve;
      });
    const service = new DownloadService(repo, engine);
    await service.initialize();
    expect(service.getSnapshot().ready).toBe(true);
    await service.add(input(["https://example.com/b.mp4"]));
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    foundSize(4096);
    await vi.waitFor(() =>
      expect(repo.tasks.find((task) => task.status === "completed")?.outputSize).toBe(4096),
    );
    engine.calls[0]!.progress({ outputSize: 2048 });
    engine.calls[0]!.resolve();
    await vi.waitFor(() =>
      expect(service.getSnapshot().tasks[1]).toMatchObject({
        status: "completed",
        outputSize: 2048,
      }),
    );
    await service.shutdown();
  });
  it("coalesces rapid tool output before publishing UI progress", async () => {
    const repo = new MemoryRepository();
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    await service.initialize();
    await service.add(input());
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    for (let progress = 1; progress <= 100; progress++) engine.calls[0]!.progress({ progress });
    expect(listener).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(service.getSnapshot().tasks[0]!.progress).toBe(100);
    unsubscribe();
    await service.shutdown();
  });
  it("blocks new work and exit until an uncertain process stop is confirmed", async () => {
    const repo = new MemoryRepository();
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    const retry = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("still running"));
    await service.initialize();
    await service.add(input());
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    engine.calls[0]!.reject(new StopUnconfirmedError(retry));
    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]!.status).toBe("failed"));
    await expect(service.add(input(["https://example.com/b.mp4"]))).rejects.toThrow("停止");
    await expect(service.shutdown()).rejects.toThrow("still running");
    expect(repo.closed).toBe(false);
    retry.mockResolvedValue();
    await service.shutdown();
    expect(repo.closed).toBe(true);
    expect(service.getSnapshot().tasks[0]!.status).toBe("paused");
  });
  it("starts once, honors concurrency and advances after the previous task exits", async () => {
    const repo = new MemoryRepository();
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    await Promise.all([service.initialize(), service.initialize()]);
    await service.add(input(["https://example.com/a.mp4", "https://example.com/b.mp4"]));
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    expect(service.getSnapshot().tasks.filter((task) => task.status === "queued")).toHaveLength(1);
    engine.calls[0]!.resolve();
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    expect(service.getSnapshot().tasks[0]!.status).toBe("completed");
    await service.shutdown();
    expect(repo.closed).toBe(true);
    expect(service.getSnapshot().tasks[1]!.status).toBe("paused");
  });
  it("aborts the process before pause resolves and ignores late progress", async () => {
    const repo = new MemoryRepository();
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    await service.initialize();
    await service.add(input());
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const id = service.getSnapshot().tasks[0]!.id;
    await service.pause(id);
    expect(engine.calls[0]!.signal.aborted).toBe(true);
    engine.calls[0]!.progress({ progress: 100 });
    expect(service.getSnapshot().tasks[0]!.status).toBe("paused");
    await Promise.all([service.resume(id), service.resume(id)]);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    await service.shutdown();
  });
  it("keeps merge inputs after failure and resumes only the merge phase", async () => {
    const repo = new MemoryRepository();
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    await service.initialize();
    await service.add(input());
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    await engine.calls[0]!.stage("merge", ["E:/fixture/source.ts"]);
    engine.calls[0]!.reject(new Error("merge failed"));
    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]!.status).toBe("failed"));
    await service.resume(service.getSnapshot().tasks[0]!.id);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    expect(engine.calls[1]!.task).toMatchObject({
      phase: "merge",
      inputs: ["E:/fixture/source.ts"],
    });
    await service.shutdown();
  });
  it("restores interrupted jobs as paused without inventing a live process", async () => {
    const repo = new MemoryRepository();
    const task = createDownloadTasks(input(), [])[0]!;
    repo.tasks = [
      { ...task, revision: 1, status: "merging", phase: "merge", inputs: ["E:/source.ts"] },
    ];
    const engine = new ControlledEngine();
    const service = new DownloadService(repo, engine);
    await service.initialize();
    expect(service.getSnapshot().tasks[0]).toMatchObject({ status: "paused", phase: "merge" });
    expect(engine.calls).toHaveLength(0);
    await service.shutdown();
  });
  it("fails visibly if SQLite cannot load and does not create browser fake tasks", async () => {
    const repo = new MemoryRepository();
    repo.load = () => Promise.reject(new Error("database unavailable"));
    const service = new DownloadService(repo, new ControlledEngine());
    await service.initialize();
    await expect(service.add(input())).rejects.toThrow("database unavailable");
    const browser = new DownloadService(repo, new ControlledEngine(), false);
    await browser.initialize();
    await expect(browser.add(input())).rejects.toThrow("桌面");
    expect(browser.getSnapshot().tasks).toEqual([]);
  });
});
