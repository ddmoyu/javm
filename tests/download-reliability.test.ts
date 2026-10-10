import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultDownloadSettings, downloadTaskLimit } from "../frontend/src/contracts/downloads";
import type { DownloadTask, NewDownload } from "../frontend/src/contracts/downloads";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import type { DownloadEngine, DownloadRepository } from "../frontend/src/services/downloads/ports";
import { ToolDownloadEngine } from "../frontend/src/services/downloads/ToolDownloadEngine";
import type { DownloadHost } from "../frontend/src/services/downloads/ToolDownloadEngine";
import type { ProcessRunner } from "../frontend/src/platform/neutralino/process";
import { deferred } from "./helpers/deferred";

const input: NewDownload = {
  urls: ["https://example.invalid/video.m3u8"],
  directory: "E:/download-reliability",
  kind: "auto",
  headers: {},
};
const ok = { exitCode: 0, stdOut: "", stdErr: "" };
const services: DownloadService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
});

function serviceFixture() {
  const tasks = new Map<string, DownloadTask>();
  const repository = {
    load: vi.fn(async () => ({
      tasks: structuredClone([...tasks.values()]),
      settings: { ...defaultDownloadSettings, directory: input.directory, concurrency: 1 },
    })),
    save: vi.fn<DownloadRepository["save"]>(async (task, revision) => {
      if ((tasks.get(task.id)?.revision ?? 0) !== revision) throw new Error("revision conflict");
      tasks.set(task.id, structuredClone(task));
    }),
    remove: vi.fn<DownloadRepository["remove"]>(async (id) => {
      tasks.delete(id);
    }),
    saveSettings: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies DownloadRepository;
  const engine = {
    defaultDirectory: async () => input.directory,
    outputSize: async () => null,
    checkTools: async () => [],
    open: async () => {},
    run: vi.fn<DownloadEngine["run"]>(async () => {}),
  } satisfies DownloadEngine;
  const service = new DownloadService(repository, engine);
  services.push(service);
  return { service, repository, engine, tasks };
}

describe("下载异常恢复", () => {
  it("提交成功但应答丢失后按数据库 revision 恢复，保留合并阶段且不自动重下", async () => {
    const f = serviceFixture();
    const save = f.repository.save.getMockImplementation()!;
    let loseReply = true;
    f.repository.save.mockImplementation(async (task, revision) => {
      await save(task, revision);
      if (task.phase === "merge" && loseReply) {
        loseReply = false;
        throw new Error("应答超时");
      }
    });
    vi.mocked(f.engine.run).mockImplementation(
      async (_task, _settings, _signal, _progress, stage) => {
        await stage("merge", ["E:/download-reliability/retained.ts"]);
      },
    );
    await f.service.initialize();
    await f.service.add(input);
    await vi.waitFor(() => expect(f.service.getSnapshot().error).toBeTruthy());
    await f.service.recover();
    const restored = f.service.getSnapshot().tasks[0]!;
    expect(restored).toMatchObject({
      status: "paused",
      phase: "merge",
      inputs: ["E:/download-reliability/retained.ts"],
    });
    expect(restored.revision).toBe(f.tasks.get(restored.id)!.revision);
    expect(f.engine.run).toHaveBeenCalledTimes(1);
    expect(f.service.getSnapshot().error).toBe("");
    await f.service.resume(restored.id);
    await vi.waitFor(() => expect(f.service.getSnapshot().tasks[0]!.status).toBe("completed"));
    expect(vi.mocked(f.engine.run).mock.calls[1]![0].phase).toBe("merge");
  });

  it("恢复先确认进程停止，再读取数据库，同时合并重复恢复请求", async () => {
    const f = serviceFixture();
    const stopped = deferred<void>();
    let abortSeen = false;
    vi.mocked(f.engine.run).mockImplementation(async (_task, _settings, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          abortSeen = true;
        },
        { once: true },
      );
      await stopped.promise;
      signal.throwIfAborted();
    });
    await f.service.initialize();
    await f.service.add(input);
    await vi.waitFor(() => expect(f.engine.run).toHaveBeenCalledOnce());
    const recovering = f.service.recover();
    expect(f.service.recover()).toBe(recovering);
    await vi.waitFor(() => expect(abortSeen).toBe(true));
    expect(f.repository.load).toHaveBeenCalledTimes(1);
    expect(f.service.getSnapshot().ready).toBe(false);
    stopped.resolve();
    await recovering;
    expect(f.repository.load).toHaveBeenCalledTimes(2);
    expect(f.service.getSnapshot().tasks[0]!.status).toBe("paused");
  });

  it("停止仍未确认时不读库、不解除冻结，后续恢复可重试", async () => {
    const f = serviceFixture();
    const retry = vi.fn<() => Promise<void>>(async () => {
      throw new Error("进程仍在运行");
    });
    vi.mocked(f.engine.run).mockRejectedValue(new StopUnconfirmedError(retry));
    await f.service.initialize();
    await f.service.add(input);
    await vi.waitFor(() => expect(f.service.getSnapshot().tasks[0]!.status).toBe("failed"));
    await expect(f.service.recover()).rejects.toThrow("仍在运行");
    expect(f.repository.load).toHaveBeenCalledOnce();
    await expect(f.service.resume(f.service.getSnapshot().tasks[0]!.id)).rejects.toThrow();
    retry.mockResolvedValue(undefined);
    await f.service.recover();
    expect(f.service.getSnapshot().error).toBe("");
  });

  it("初始化失败后可以重新读库，读库仍失败时保留记录与错误", async () => {
    const f = serviceFixture();
    const task = {
      ...createDownloadTasks(input, [])[0]!,
      revision: 1,
      status: "completed" as const,
      outputSize: 5,
    };
    f.tasks.set(task.id, task);
    vi.mocked(f.repository.load).mockRejectedValueOnce(new Error("数据库离线"));
    await f.service.initialize();
    await f.service.recover();
    expect(f.service.getSnapshot().tasks).toEqual([task]);
    vi.mocked(f.repository.load).mockRejectedValueOnce(new Error("数据库仍离线"));
    await expect(f.service.recover()).rejects.toThrow("仍离线");
    expect(f.service.getSnapshot().tasks).toEqual([task]);
    await f.service.recover();
    expect(f.service.getSnapshot().error).toBe("");
  });

  it("恢复遗漏的刮削交接，不重复下载已经完成的视频", async () => {
    const f = serviceFixture();
    const task = {
      ...createDownloadTasks(input, [])[0]!,
      revision: 1,
      status: "completed" as const,
      outputSize: 5,
    };
    f.tasks.set(task.id, task);
    vi.mocked(f.repository.load).mockRejectedValueOnce(new Error("数据库离线"));
    const handoff = vi.fn(async () => "scrape-recovered");
    f.service.connectScraping(handoff);
    await f.service.initialize();
    await f.service.recover();
    await vi.waitFor(() =>
      expect(f.service.getSnapshot().tasks[0]!.scrapeTaskId).toBe("scrape-recovered"),
    );
    expect(handoff).toHaveBeenCalledOnce();
    expect(f.engine.run).not.toHaveBeenCalled();
  });

  it("批次超过总量上限时一条也不加入，移除记录后可再次新增", async () => {
    const f = serviceFixture();
    const base = createDownloadTasks(input, [])[0]!;
    for (let index = 0; index < downloadTaskLimit - 1; index++) {
      const task = { ...base, id: String(index), revision: 1, status: "cancelled" as const };
      f.tasks.set(task.id, task);
    }
    await f.service.initialize();
    await expect(
      f.service.add({
        ...input,
        urls: ["https://example.invalid/1.mp4", "https://example.invalid/2.mp4"],
      }),
    ).rejects.toThrow("1000");
    expect(f.repository.save).not.toHaveBeenCalled();
    await f.service.remove("0");
    expect(
      await f.service.add({
        ...input,
        urls: ["https://example.invalid/1.mp4", "https://example.invalid/2.mp4"],
      }),
    ).toBe(2);
  });
});

describe("HLS 尝试隔离与协作取消", () => {
  it.each(["取消", "网络失败"])(
    "%s留下的残轨不参与下一次合并，分片目录继续复用",
    async (reason) => {
      const task = createDownloadTasks(input, [])[0]!;
      const files = new Map<string, string>();
      const attempts: string[] = [];
      const segments: string[] = [];
      let attempt = 0;
      const controller = new AbortController();
      const run = vi.fn<ProcessRunner>(async (file, args) => {
        if (file === "ffmpeg") {
          for (const [index, arg] of args.entries())
            if (arg === "-i") expect(files.get(args[index + 1]!)).toBe("complete");
          files.set(args.at(-1)!, "complete");
        } else {
          const destination = args[args.indexOf("--save-dir") + 1]!;
          attempts.push(destination);
          segments.push(args[args.indexOf("--tmp-dir") + 1]!);
          files.set(`${destination}/media.ts`, attempt++ ? "complete" : "partial");
          if (attempt === 1) {
            if (reason === "取消") {
              controller.abort();
              controller.signal.throwIfAborted();
            }
            return { ...ok, exitCode: 1, stdErr: "connection reset" };
          }
        }
        return ok;
      });
      const host: DownloadHost = {
        run,
        tool: async (name) => name,
        defaultDirectory: async () => input.directory,
        open: async () => {},
        probe: vi.fn(async (path) => {
          if (files.get(path) === "partial") throw new Error("不应读取旧残片");
          return {
            video: true,
            audio: true,
            videoTracks: 1,
            audioTracks: 1,
            durationMs: 12000,
            width: 320,
            height: 180,
            audioChannels: 2,
            audioLanguage: "",
          };
        }),
        files: {
          mkdir: async () => {},
          stat: async (path) =>
            files.has(path) ? { isFile: true, size: files.get(path)!.length } : null,
          read: async (path) => files.get(path)!,
          write: async (path, value) => {
            files.set(path, value);
          },
          list: async (directory) =>
            [...files.keys()].filter((path) => path.startsWith(`${directory}/`)),
          move: async (from, to) => {
            files.set(to, files.get(from)!);
            files.delete(from);
          },
          remove: async (directory) => {
            for (const path of files.keys()) if (path.startsWith(directory)) files.delete(path);
          },
        },
      };
      const engine = new ToolDownloadEngine(host);
      await expect(
        engine.run(
          task,
          defaultDownloadSettings,
          controller.signal,
          () => {},
          async () => {},
        ),
      ).rejects.toThrow();
      expect(files.get(`${attempts[0]}/media.ts`)).toBe("partial");
      await engine.run(
        task,
        defaultDownloadSettings,
        new AbortController().signal,
        () => {},
        async () => {},
      );
      expect(attempts[0]).not.toBe(attempts[1]);
      expect(segments[0]).toBe(segments[1]);
      expect(files.get(task.output)).toBe("complete");
      expect(run.mock.calls.every((call) => call[4] === true)).toBe(true);
    },
  );

  it("MP4 下载、合并和工具检查均启用协作取消", async () => {
    const task = createDownloadTasks(
      { ...input, urls: ["https://example.invalid/video.mp4"] },
      [],
    )[0]!;
    const run = vi.fn<ProcessRunner>(async () => ok);
    const host: DownloadHost = {
      run,
      tool: async (name) => name,
      defaultDirectory: async () => input.directory,
      open: async () => {},
      probe: async () => ({
        video: true,
        audio: true,
        videoTracks: 1,
        audioTracks: 1,
        durationMs: 12000,
        width: 320,
        height: 180,
        audioChannels: 2,
        audioLanguage: "",
      }),
      files: {
        mkdir: async () => {},
        read: async () => "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n",
        write: async () => {},
        list: async () => [],
        move: async () => {},
        remove: async () => {},
        stat: async (path) =>
          path === task.output || path.endsWith("resume.json") ? null : { isFile: true, size: 5 },
      },
    };
    const engine = new ToolDownloadEngine(host);
    await engine.run(
      task,
      defaultDownloadSettings,
      new AbortController().signal,
      () => {},
      async () => {},
    );
    await engine.checkTools(defaultDownloadSettings);
    expect(run.mock.calls).toHaveLength(5);
    expect(run.mock.calls.every((call) => call[4] === true)).toBe(true);
  });
});
