import { events, extensions } from "@neutralinojs/lib";
import type { DownloadRepository } from "../../services/downloads/ports";
import type { DownloadSettings, DownloadTask } from "../../contracts/downloads";
import { recoverNativeProcesses } from "./process";
import { logEvent } from "../../services/logging/events";
import { importDownloadLog } from "../../services/logging/legacyDownloads";
import { waitForUpdateStartup } from "./updateGate";
import { nativeSettingsStorage } from "./settingsStorage";
import { readDownloadSettings, validateSettings } from "../../services/downloads/input";

const extensionId = "net.ddmoyu.javm.database";
export class NativeDownloadRepository implements DownloadRepository {
  private settingsStore = nativeSettingsStorage<DownloadSettings>("javm-download-settings-v1");
  private stopping = false;
  private recoveredProcesses = false;
  beginShutdown() {
    this.stopping = true;
  }
  constructor(private importLegacyProxy?: (proxy: string) => Promise<void>) {}
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listening?: Promise<void>;
  private listener = (
    event: CustomEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>,
  ) => {
    const reply = event.detail;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result);
    else {
      logEvent("error", "database", "request_failed", reply.error || "下载数据库操作失败", {
        requestId: reply.requestId,
      });
      pending.reject(new Error(`下载数据库：${reply.error || "操作失败"}`));
    }
  };
  private async request<T>(method: string, params: unknown = {}): Promise<T> {
    await waitForUpdateStartup();
    this.listening ??= events.on("javm.database.response", this.listener).then(() => {});
    await this.listening;
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("下载数据库未响应，请尝试恢复下载服务；若仍失败，请检查数据库扩展。"));
      }, 15000);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      void extensions
        .dispatch(extensionId, "javm.database.request", { requestId, protocol: 1, method, params })
        .catch((error: unknown) => {
          if (!this.pending.delete(requestId)) return;
          clearTimeout(timer);
          reject(error);
        });
    });
  }
  async load() {
    await this.request("hello");
    if (!this.recoveredProcesses) {
      await recoverNativeProcesses();
      this.recoveredProcesses = true;
    }
    const tasks: DownloadTask[] = [];
    const rawSettings = await this.settingsStore.read();
    // Storage 中已有配置时优先使用，读取失败或损坏时不能回退并覆盖它。
    const stored = rawSettings === null ? null : readDownloadSettings(rawSettings);
    let legacySettings: unknown;
    for (let offset = 0; ;) {
      const page = await this.request<{
        tasks: DownloadTask[];
        settings: unknown;
        nextOffset: number | null;
      }>("downloads.load", { offset });
      if (
        !Array.isArray(page.tasks) ||
        page.tasks.length > 100 ||
        (page.nextOffset !== null &&
          (!Number.isSafeInteger(page.nextOffset) ||
            page.nextOffset !== offset + page.tasks.length ||
            !page.tasks.length))
      )
        throw new Error("下载数据库分页响应无效，请更新数据库扩展后恢复下载服务。");
      if (offset === 0) {
        legacySettings = page.settings;
        if (legacySettings && typeof legacySettings === "object" && "proxy" in legacySettings) {
          const proxy = legacySettings.proxy;
          if (typeof proxy === "string") await this.importLegacyProxy?.(proxy);
        }
      }
      tasks.push(...page.tasks);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // 首次读取旧库后只写官方 Storage，保留旧表供兼容和回退，不双写配置。
    const settings =
      stored ??
      readDownloadSettings(
        await this.settingsStore.migrate(() => readDownloadSettings(legacySettings)),
      );
    for (let index = 0; index < tasks.length; index++) {
      if (this.stopping) break;
      const task = tasks[index]!;
      if (!task.log?.length || !(await importDownloadLog(task, () => this.stopping))) continue;
      const cleaned = { ...task, log: [], revision: task.revision + 1 };
      await this.save(cleaned, task.revision);
      tasks[index] = cleaned;
    }
    return { tasks, settings };
  }
  async save(task: DownloadTask, expectedRevision: number) {
    await this.request("downloads.save", { task, expectedRevision });
  }
  async remove(id: string, revision: number) {
    await this.request("downloads.remove", { id, revision });
  }
  async saveSettings(settings: DownloadSettings) {
    await this.settingsStore.write(validateSettings(readDownloadSettings(settings)));
  }
  async close() {
    if (!this.listening) return;
    await this.request("close");
    await events.off("javm.database.response", this.listener);
  }
}
