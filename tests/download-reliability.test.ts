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

describe("HLS 续传与协作取消", () => {
  it.each(["取消", "网络失败"])("%s后只补下载缺失分片，半写入的分片不参与合并", async (reason) => {
    const task = createDownloadTasks(input, [])[0]!;
    const files = new Map<string, string>();
    const segmentLists: string[][] = [];
    const controller = new AbortController();
    const run = vi.fn<ProcessRunner>(async (file, args, _signal, output) => {
      if (file === "ffmpeg") {
        // 合并时每个本地分片都必须完整。
        for (const [path, value] of files)
          if (path.includes("/hls/") && path.endsWith(".ts")) expect(value).toBe("complete");
        files.set(args.at(-1)!, "complete");
        return ok;
      }
      const config = files.get(args[args.indexOf("--config") + 1]!)!;
      const outputs = [...config.matchAll(/^output = "(.*)"$/gm)].map((match) => match[1]!);
      if (outputs[0]!.endsWith("fetch.m3u8")) {
        files.set(
          outputs[0]!,
          "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXTINF:4,\nc.ts\n#EXT-X-ENDLIST\n",
        );
        return { ...ok, stdOut: task.url };
      }
      segmentLists.push(outputs.map((path) => path.split("/").at(-1)!));
      const report = (path: string, code: number) =>
        output?.(
          `javm-transfer\t${code}\t${code ? 0 : 200}\t${code ? 0 : 8}\tvideo/mp2t\t${path}\n`,
          "stderr",
        );
      if (segmentLists.length === 1) {
        // 第一次：一个分片完成，一个只写了一半，第三个还没开始。
        files.set(outputs[0]!, "complete");
        report(outputs[0]!, 0);
        files.set(outputs[1]!, "partial");
        if (reason === "取消") {
          controller.abort();
          return { ...ok, exitCode: -1 };
        }
        report(outputs[1]!, 56);
        return { ...ok, exitCode: 56, stdErr: "curl: (56) connection reset" };
      }
      for (const path of outputs) {
        files.set(path, "complete");
        report(path, 0);
      }
      return ok;
    });
    const host: DownloadHost = {
      run,
      tool: async (name) => name,
      defaultDirectory: async () => input.directory,
      open: async () => {},
      probe: vi.fn(async () => ({
        video: true,
        audio: false,
        videoTracks: 1,
        audioTracks: 0,
        durationMs: 12000,
        width: 320,
        height: 180,
        audioChannels: 0,
        audioLanguage: "",
      })),
      files: {
        mkdir: async () => {},
        stat: async (path) =>
          files.has(path) ? { isFile: true, size: files.get(path)!.length } : null,
        read: async (path) => {
          if (!files.has(path)) throw new Error("missing");
          return files.get(path)!;
        },
        write: async (path, value) => {
          files.set(path, value);
        },
        list: async (directory) =>
          [...files.keys()].filter((path) => path.startsWith(`${directory}/`)),
        move: async (from, to) => {
          files.set(to, files.get(from)!);
          files.delete(from);
        },
        remove: async (target) => {
          for (const path of files.keys())
            if (path === target || path.startsWith(`${target}/`)) files.delete(path);
        },
      },
    };
    // 关闭同一次运行内的自动补下载，验证跨两次运行的续传。
    const engine = new ToolDownloadEngine(host, undefined, { hlsRetryDelays: [] });
    await expect(
      engine.run(
        task,
        defaultDownloadSettings,
        controller.signal,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow();
    expect(files.has(task.output)).toBe(false);
    await engine.run(
      task,
      defaultDownloadSettings,
      new AbortController().signal,
      () => {},
      async () => {},
    );
    expect(segmentLists).toHaveLength(2);
    expect(segmentLists[0]).toHaveLength(3);
    // 已记录完成的分片不再下载；半写入的分片和未开始的分片重新下载。
    expect(segmentLists[1]).toHaveLength(2);
    expect(segmentLists[1]).not.toContain(segmentLists[0]![0]);
    expect(segmentLists[1]).toContain(segmentLists[0]![1]);
    expect(files.get(task.output)).toBe("complete");
    expect(run.mock.calls.every((call) => call[4] === true)).toBe(true);
  });

  it("慢盘上只保留最新一份进度快照，并以临时文件改名替换", async () => {
    const task = createDownloadTasks(input, [])[0]!;
    const files = new Map<string, string>();
    const stateWrites: string[] = [];
    const moves: [string, string][] = [];
    const disk = deferred<void>();
    let clock = 0;
    // 每次取时间都前进 3 秒，让每个分片完成时都越过 2 秒的保存节流。
    const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 3000));
    const count = 200;
    const run = vi.fn<ProcessRunner>(async (file, args, _signal, output) => {
      if (file === "ffmpeg") {
        files.set(args.at(-1)!, "complete");
        return ok;
      }
      const config = files.get(args[args.indexOf("--config") + 1]!)!;
      const outputs = [...config.matchAll(/^output = "(.*)"$/gm)].map((match) => match[1]!);
      if (outputs[0]!.endsWith("fetch.m3u8")) {
        const rows = ["#EXTM3U", "#EXT-X-TARGETDURATION:4"];
        for (let index = 0; index < count; index++) rows.push("#EXTINF:4,", `s${index}.ts`);
        files.set(outputs[0]!, [...rows, "#EXT-X-ENDLIST"].join("\n"));
        return { ...ok, stdOut: task.url };
      }
      for (const path of outputs) {
        files.set(path, "complete");
        output?.(`javm-transfer\t0\t200\t8\tvideo/mp2t\t${path}\n`, "stderr");
      }
      // 进程结束前放开被阻塞的磁盘写入。
      disk.resolve();
      return ok;
    });
    const host: DownloadHost = {
      run,
      tool: async (name) => name,
      defaultDirectory: async () => input.directory,
      open: async () => {},
      probe: async () => ({
        video: true,
        audio: false,
        videoTracks: 1,
        audioTracks: 0,
        durationMs: count * 4000,
        width: 320,
        height: 180,
        audioChannels: 0,
        audioLanguage: "",
      }),
      files: {
        mkdir: async () => {},
        stat: async (path) =>
          files.has(path) ? { isFile: true, size: files.get(path)!.length } : null,
        read: async (path) => {
          if (!files.has(path)) throw new Error("missing");
          return files.get(path)!;
        },
        write: async (path, value) => {
          if (path.endsWith("state.json.tmp")) {
            stateWrites.push(value);
            await disk.promise;
          }
          if (path.endsWith("state.json")) throw new Error("进度记录不能被直接覆盖");
          files.set(path, value);
        },
        list: async (directory) =>
          [...files.keys()].filter((path) => path.startsWith(`${directory}/`)),
        move: async (from, to) => {
          moves.push([from, to]);
          files.set(to, files.get(from)!);
          files.delete(from);
        },
        remove: async () => {},
      },
    };
    try {
      await new ToolDownloadEngine(host).run(
        task,
        defaultDownloadSettings,
        new AbortController().signal,
        () => {},
        async () => {},
      );
    } finally {
      now.mockRestore();
    }
    // 第一次写入期间到达的 200 次保存请求只合并为一次后续写入。
    expect(stateWrites.length).toBeLessThanOrEqual(2);
    // 最终视频本身也通过改名发布；这里只看进度记录的写入方式。
    const stateMoves = moves.filter(([, to]) => to.endsWith("hls/state.json"));
    expect(stateMoves.length).toBe(stateWrites.length);
    expect(stateMoves.every(([from, to]) => from === `${to}.tmp`)).toBe(true);
    const statePath = stateMoves.at(-1)![1];
    const saved = JSON.parse(files.get(statePath)!) as { completed: Record<string, number> };
    expect(Object.keys(saved.completed)).toHaveLength(count);
    expect(files.get(task.output)).toBe("complete");
  });

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
    expect(run.mock.calls).toHaveLength(4);
    expect(run.mock.calls.every((call) => call[4] === true)).toBe(true);
  });
});
