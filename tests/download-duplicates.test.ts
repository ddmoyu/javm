import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultDownloadSettings, downloadLabels } from "../frontend/src/contracts/downloads";
import type {
  DownloadStatus,
  DownloadTask,
  NewDownload,
} from "../frontend/src/contracts/downloads";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import {
  DownloadAdditionCancelledError,
  DuplicateDownloadError,
} from "../frontend/src/services/downloads/duplicates";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import type { DownloadEngine, DownloadRepository } from "../frontend/src/services/downloads/ports";

const input = (leaf = "new", name = "DEMO-001"): NewDownload => ({
  urls: [`https://safe.example.invalid/${leaf}.mp4`],
  name,
  directory: "E:/safe-downloads",
  kind: "auto",
  headers: {},
});
const existing = (status: DownloadStatus = "completed"): DownloadTask => ({
  ...createDownloadTasks(input("old"), [])[0]!,
  status,
  revision: 1,
  outputSize: 0,
});
const services: DownloadService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
});

async function fixture(initial = [existing()]) {
  const tasks = new Map(initial.map((task) => [task.id, structuredClone(task)]));
  const settings = { ...defaultDownloadSettings, directory: input().directory };
  const repository = {
    load: async () => ({ tasks: [...tasks.values()], settings }),
    save: vi.fn<DownloadRepository["save"]>(async (task, revision) => {
      if ((tasks.get(task.id)?.revision ?? 0) !== revision) throw new Error("revision conflict");
      tasks.set(task.id, structuredClone(task));
    }),
    remove: async (id: string) => {
      tasks.delete(id);
    },
    saveSettings: async () => {},
    close: vi.fn(async () => {}),
  } satisfies DownloadRepository;
  const engine = {
    defaultDirectory: async () => settings.directory,
    outputSize: async () => null,
    open: async () => {},
    checkTools: async () => [],
    run: vi.fn<DownloadEngine["run"]>(async (_task, _settings, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
    }),
  } satisfies DownloadEngine;
  const service = new DownloadService(repository, engine);
  services.push(service);
  await service.initialize();
  repository.save.mockClear();
  return { service, repository, engine, tasks };
}

async function prompt(service: DownloadService) {
  await vi.waitFor(() => expect(service.getConfirmation()).not.toBeNull());
  return service.getConfirmation()!;
}

describe("重复番号下载确认（仅安全虚构数据）", () => {
  it("所有保留状态及旧记录均识别大小写、空格和横线差异", () => {
    for (const status of Object.keys(downloadLabels) as DownloadStatus[]) {
      const task = { ...existing(status), code: undefined, name: "demo_001" };
      expect(() => createDownloadTasks(input("new", "ＤＥＭＯ ００１"), [task])).toThrow(
        DuplicateDownloadError,
      );
    }
  });

  it("改文件名后仍使用保存的番号，无番号和不同番号可正常添加", () => {
    const task = { ...existing(), name: "旅行记录" };
    expect(() => createDownloadTasks(input(), [task])).toThrow(DuplicateDownloadError);
    expect(createDownloadTasks(input("other", "DEMO-002"), [task])).toHaveLength(1);
    expect(createDownloadTasks(input("other", "旅行记录"), [task])).toHaveLength(1);
  });

  it("取消前不写入、不启动，取消后不产生新任务", async () => {
    const f = await fixture();
    const addition = f.service.add(input()).catch((error: unknown) => error);
    const confirmation = await prompt(f.service);
    expect(confirmation).toMatchObject({ codes: ["DEMO-001"], count: 1 });
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.engine.run).not.toHaveBeenCalled();
    f.service.resolveDuplicateConfirmation(confirmation.id, false);
    expect(await addition).toBeInstanceOf(DownloadAdditionCancelledError);
    expect(f.tasks.size).toBe(1);
    expect(f.service.getConfirmation()).toBeNull();
  });

  it("确认后同链接同番号也可新增一次，旧任务保持不变", async () => {
    const task = existing("paused");
    const f = await fixture([task]);
    const addition = f.service.add(input("old"));
    const confirmation = await prompt(f.service);
    f.service.resolveDuplicateConfirmation(confirmation.id, true);
    f.service.resolveDuplicateConfirmation(confirmation.id, true);
    expect(await addition).toBe(1);
    expect(f.tasks.size).toBe(2);
    expect(f.tasks.get(task.id)).toEqual(task);
    expect(f.service.getConfirmation()).toBeNull();
  });

  it("批量中重复的番号只提示一次，取消时整批都不添加", async () => {
    const f = await fixture([]);
    const addition = f.service
      .add({
        ...input(),
        urls: [input("first").urls[0]!, input("second").urls[0]!],
      })
      .catch((error: unknown) => error);
    const confirmation = await prompt(f.service);
    expect(confirmation).toMatchObject({ codes: ["DEMO-001"], count: 2 });
    f.service.resolveDuplicateConfirmation(confirmation.id, false);
    expect(await addition).toBeInstanceOf(DownloadAdditionCancelledError);
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.tasks.size).toBe(0);
  });

  it("等待确认不会阻塞其他下载，确认时会重新检查新出现的重复番号", async () => {
    const f = await fixture();
    const addition = f.service
      .add({
        ...input(),
        name: "",
        urls: [input("DEMO-001").urls[0]!, input("DEMO-002").urls[0]!],
      })
      .catch((error: unknown) => error);
    const first = await prompt(f.service);
    expect(await f.service.add(input("other", "DEMO-002"))).toBe(1);
    await vi.waitFor(() => expect(f.engine.run).toHaveBeenCalledOnce());
    f.service.resolveDuplicateConfirmation(first.id, true);
    const second = await prompt(f.service);
    expect(second.codes).toEqual(["DEMO-002"]);
    f.service.resolveDuplicateConfirmation(second.id, false);
    expect(await addition).toBeInstanceOf(DownloadAdditionCancelledError);
    expect(f.tasks.size).toBe(2);
  });

  it("并发的重复请求不能覆盖当前弹框，过期确认不能添加任务", async () => {
    const f = await fixture();
    const addition = f.service.add(input()).catch((error: unknown) => error);
    const confirmation = await prompt(f.service);
    await expect(f.service.add(input("another"))).rejects.toThrow("请先处理");
    expect(f.service.getConfirmation()?.id).toBe(confirmation.id);
    f.service.resolveDuplicateConfirmation("expired", true);
    expect(f.repository.save).not.toHaveBeenCalled();
    f.service.resolveDuplicateConfirmation(confirmation.id, false);
    expect(await addition).toBeInstanceOf(DownloadAdditionCancelledError);
  });

  it("退出会取消待确认请求，依赖下载交接的服务能够完成收尾", async () => {
    const f = await fixture();
    const addition = f.service.add(input()).catch((error: unknown) => error);
    await prompt(f.service);
    await f.service.shutdown(async () => {
      expect(await addition).toBeInstanceOf(DownloadAdditionCancelledError);
    });
    expect(f.repository.close).toHaveBeenCalledOnce();
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.service.getConfirmation()).toBeNull();
  });
});
