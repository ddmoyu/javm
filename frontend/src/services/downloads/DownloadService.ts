import { canResume, defaultDownloadSettings, isRunning } from "../../contracts/downloads";
import type { DownloadSettings, DownloadTask, NewDownload } from "../../contracts/downloads";
import { createDownloadTasks, redactLog, validateSettings, safeName, joinPath } from "./input";
import type { DownloadEngine, DownloadProgress, DownloadRepository } from "./ports";
import { StopUnconfirmedError } from "./ports";
import { logEvent } from "../logging/events";

interface Snapshot {
  tasks: DownloadTask[];
  settings: DownloadSettings;
  ready: boolean;
  error: string;
  available: boolean;
}
type Controls = Omit<Snapshot, "tasks">;
interface Execution {
  controller: AbortController;
  stop?: "paused" | "cancelled";
  done: Promise<void>;
  finish: () => void;
  lastSaved: number;
  pending?: DownloadProgress;
}

export class DownloadService {
  private snapshot: Snapshot;
  private controls: Controls;
  private listeners = new Set<() => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private active = new Map<string, Execution>();
  private uncertainStops = new Map<string, StopUnconfirmedError>();
  private starting?: Promise<void>;
  private recovery?: Promise<void>;
  private stopping = false;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private completedHandler?: (task: DownloadTask) => Promise<unknown>;
  private handoffs = new Set<Promise<void>>();
  private renameFile?: (
    task: DownloadTask,
    pending: NonNullable<DownloadTask["rename"]>,
  ) => Promise<void>;
  connectFileRename(
    handler: (task: DownloadTask, pending: NonNullable<DownloadTask["rename"]>) => Promise<void>,
  ) {
    this.renameFile = handler;
  }
  async edit(id: string, name: string) {
    await this.initialize();
    return this.exclusive(async () => {
      let task = this.find(id);
      if (
        this.stopping ||
        this.active.has(id) ||
        isRunning(task.status) ||
        task.status === "queued"
      )
        throw new Error("请先暂停任务后再修改。");
      const cleaned = safeName(name);
      if (!name.trim() || cleaned !== name.trim())
        throw new Error("请使用有效的文件名，不含路径或扩展名。");
      if (task.rename && task.rename.name !== cleaned)
        throw new Error("请先完成上次改名，再修改名称。");
      if (cleaned !== task.name || task.rename) {
        const pending = task.rename ?? {
          name: cleaned,
          output: joinPath(task.directory, `${cleaned}.mp4`),
          operationId: crypto.randomUUID(),
        };
        const exists = task.rename || (await this.engine.outputSize(task.output)) !== null;
        if (exists) {
          if (!this.renameFile) throw new Error("当前环境无法修改下载文件名。");
          if (!task.rename) {
            await this.save({ ...task, rename: pending });
            task = this.find(id);
          }
          await this.renameFile(task, pending);
        }
        await this.save({
          ...this.find(id),
          name: pending.name,
          output: pending.output,
          rename: undefined,
        });
        task = this.find(id);
      }
    });
  }

  connectScraping(handler: (task: DownloadTask) => Promise<unknown>) {
    this.completedHandler = handler;
    void this.initialize().then(() => this.restoreHandoffs());
  }
  hasPendingHandoffs() { return this.handoffs.size > 0; }
  private async restoreHandoffs() {
    for (const task of this.snapshot.tasks) {
      if (this.stopping || this.snapshot.error) break;
      if (task.status === "completed" && task.scrapeAfterDownload && !task.scrapeTaskId)
        await this.handoff(task);
    }
  }
  private handoff(task: DownloadTask) {
    const handler = this.completedHandler;
    if (!handler || !task.scrapeAfterDownload || this.stopping) return Promise.resolve();
    const pending = Promise.resolve()
      .then(() => handler(task))
      .then(
        async (id) => {
          await this.exclusive(async () => {
            const current = this.snapshot.tasks.find((item) => item.id === task.id);
            if (current && typeof id === "string")
              await this.save({ ...current, scrapeTaskId: id, scrapeHandoffError: "" });
          });
        },
        async (error: unknown) => {
          await this.exclusive(async () => {
            const current = this.snapshot.tasks.find((item) => item.id === task.id);
            if (current) await this.save({ ...current, scrapeHandoffError: describeError(error) });
          });
        },
      )
      .catch((error: unknown) => this.publish({ error: describeError(error) }));
    this.handoffs.add(pending);
    void pending.finally(() => this.handoffs.delete(pending));
    return pending;
  }

  constructor(
    private repository: DownloadRepository,
    private engine: DownloadEngine,
    available = true,
  ) {
    this.snapshot = {
      tasks: [],
      settings: defaultDownloadSettings,
      ready: false,
      error: "",
      available,
    };
    this.controls = { settings: this.snapshot.settings, ready: false, error: "", available };
  }
  getSnapshot = () => this.snapshot;
  getControls = () => this.controls;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<Snapshot>) {
    if (patch.error && patch.error !== this.snapshot.error)
      logEvent("error", "downloads", "failed", patch.error);
    this.snapshot = { ...this.snapshot, ...patch };
    const { settings, ready, error, available } = this.snapshot;
    if (
      settings !== this.controls.settings ||
      ready !== this.controls.ready ||
      error !== this.controls.error ||
      available !== this.controls.available
    )
      this.controls = { settings, ready, error, available };
    for (const listener of this.listeners) listener();
  }
  private exclusive<T>(operation: () => Promise<T>) {
    const pending = this.serial.then(operation);
    this.serial = pending.catch(() => {});
    return pending;
  }
  private find(id: string) {
    const task = this.snapshot.tasks.find((item) => item.id === id);
    if (!task) throw new Error("任务不存在或已移除。");
    return task;
  }
  private replace(task: DownloadTask) {
    const exists = this.snapshot.tasks.some((item) => item.id === task.id);
    this.publish({
      tasks: exists
        ? this.snapshot.tasks.map((item) => (item.id === task.id ? task : item))
        : [...this.snapshot.tasks, task],
    });
  }
  private async save(task: DownloadTask, preserveProgress = false) {
    const previous = this.snapshot.tasks.find((item) => item.id === task.id);
    // 后续诊断只进入统一日志；尚未确认迁移成功的旧内容暂时随任务保留。
    const saved = {
      ...task,
      revision: task.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.repository.save(saved, task.revision);
    } catch (error) {
      // 请求超时也可能已经提交；恢复前不能用旧 revision 再次写入。
      this.publish({ error: describeError(error) });
      throw error;
    }
    if (previous?.status !== task.status)
      logEvent(
        task.status === "failed" ? "error" : "info",
        "downloads",
        "state_changed",
        task.error ? redactLog(task.error, task) : `下载任务 ${task.status}`,
        { taskId: task.id, phase: task.phase },
      );
    // Progress can advance while the asynchronous database write is in flight.
    this.replace(
      preserveProgress
        ? { ...this.find(task.id), revision: saved.revision, updatedAt: saved.updatedAt }
        : saved,
    );
    if (saved.status === "completed" && previous?.status !== "completed") void this.handoff(saved);
  }
  initialize() {
    this.starting ??= this.exclusive(async () => {
      if (!this.snapshot.available) {
        this.publish({ ready: true });
        return;
      }
      try {
        await this.restoreTasks();
        void this.refreshCompletedSizes().catch((error: unknown) =>
          this.publish({ error: describeError(error) }),
        );
      } catch (error) {
        this.publish({ ready: true, error: describeError(error) });
      }
    });
    return this.starting;
  }
  private async restoreTasks() {
    const { tasks, settings } = await this.repository.load();
    const resolved = { ...defaultDownloadSettings, ...settings };
    if (!resolved.directory) resolved.directory = await this.engine.defaultDirectory();
    this.publish({ tasks, settings: validateSettings(resolved) });
    // 只在所属进程确认停止后调用；以数据库实际 revision 为准，不重放旧写入。
    for (const task of tasks) {
      if (isRunning(task.status) || task.status === "queued")
        await this.save({
          ...task,
          status: "paused",
          speed: 0,
          error: "上次任务未完成，可继续下载或合并。",
        });
    }
    this.publish({ ready: true, error: "" });
  }
  recover() {
    if (this.recovery) return this.recovery;
    if (!this.snapshot.available)
      return Promise.reject(new Error("请在 JAVM 桌面应用中恢复下载服务。"));
    if (this.stopping) return Promise.reject(new Error("应用正在退出。"));
    this.recovery = this.recoverStoppedTasks().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async recoverStoppedTasks() {
    this.stopping = true;
    this.publish({ ready: false });
    try {
      // 先排空已经开始的调度，再停止实际执行；写库失败也不能跳过进程收尾。
      await this.serial;
      const executions = [...this.active.entries()];
      for (const [id, execution] of executions) {
        this.flushProgress(id, execution);
        execution.stop = "paused";
        execution.controller.abort();
      }
      await Promise.all(executions.map(([, execution]) => execution.done));
      for (const [id, uncertain] of this.uncertainStops) {
        await uncertain.retry();
        this.uncertainStops.delete(id);
      }
      await Promise.all(this.handoffs);
      await this.exclusive(() => this.restoreTasks());
    } catch (error) {
      this.publish({ ready: true, error: describeError(error) });
      throw error;
    } finally {
      this.stopping = false;
    }
    void this.refreshCompletedSizes().catch((error: unknown) =>
      this.publish({ error: describeError(error) }),
    );
    void this.restoreHandoffs();
  }
  private async refreshCompletedSizes() {
    // Old records have no output size. Stat one file at a time in the background,
    // after the UI is ready; never read video contents or delay queue startup.
    for (const task of this.snapshot.tasks) {
      if (this.stopping) return;
      if (task.status !== "completed" || task.outputSize !== undefined) continue;
      const outputSize = await this.engine.outputSize(task.output).catch(() => null);
      if (outputSize === null) continue;
      await this.exclusive(async () => {
        if (this.stopping) return;
        const current = this.snapshot.tasks.find((item) => item.id === task.id);
        if (current?.status === "completed" && current.outputSize === undefined)
          await this.save({ ...current, outputSize });
      });
    }
  }
  private requireReady() {
    if (!this.snapshot.available) throw new Error("请在 JAVM 桌面应用中下载视频。");
    if (!this.snapshot.ready || this.snapshot.error)
      throw new Error(this.snapshot.error || "正在读取下载任务，请稍候。");
    if (this.stopping) throw new Error("应用正在退出，无法启动新任务。");
  }
  async add(input: NewDownload) {
    const count = await this.exclusive(async () => {
      this.requireReady();
      const tasks = createDownloadTasks(input, this.snapshot.tasks);
      for (const task of tasks) await this.save(task);
      return tasks.length;
    });
    this.pump();
    return count;
  }
  async updateSettings(settings: DownloadSettings) {
    await this.exclusive(async () => {
      this.requireReady();
      validateSettings(settings);
      await this.repository.saveSettings(settings);
      this.publish({ settings });
    });
    this.pump();
  }
  checkTools(settings = this.snapshot.settings) {
    return this.engine.checkTools(settings);
  }
  async open(id: string, folder = false) {
    this.requireReady();
    const task = this.find(id);
    if (!folder && task.status !== "completed") throw new Error("任务尚未完成。");
    await this.engine.open(folder ? task.directory : task.output);
  }
  private pump() {
    void this.exclusive(async () => {
      if (this.stopping || this.snapshot.error || !this.snapshot.ready) return;
      for (const task of this.snapshot.tasks) {
        if (this.active.size >= this.snapshot.settings.concurrency) break;
        if (task.status !== "queued" || this.active.has(task.id)) continue;
        let finish!: () => void;
        const execution: Execution = {
          controller: new AbortController(),
          done: new Promise<void>((resolve) => {
            finish = resolve;
          }),
          finish: () => finish(),
          lastSaved: Date.now(),
        };
        this.active.set(task.id, execution);
        try {
          await this.save({ ...task, status: "preparing", error: "", speed: 0 });
        } catch (error) {
          this.active.delete(task.id);
          execution.finish();
          throw error;
        }
        void this.execute(task.id, execution);
      }
    }).catch((error: unknown) => this.publish({ error: describeError(error) }));
  }
  private progress(id: string, execution: Execution, update: DownloadProgress) {
    if (this.active.get(id) !== execution || execution.stop) return;
    const { line, ...stats } = update;
    execution.pending = { ...execution.pending, ...stats };
    if (line) {
      const level = /error|failed|failure|失败|错误/i.test(line)
        ? "error"
        : /warn|警告/i.test(line)
          ? "warn"
          : /\d+(?:\.\d+)?%/.test(line)
            ? "debug"
            : "info";
      if (level !== "debug")
        logEvent(level, "downloads", "tool_output", redactLog(line, this.find(id)), { taskId: id });
    }
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined;
      this.flushProgress();
    }, 200);
  }
  private flushProgress(onlyId?: string, onlyExecution?: Execution) {
    const changed = new Map<string, DownloadTask>();
    for (const [id, execution] of this.active) {
      if (onlyId && (onlyId !== id || onlyExecution !== execution)) continue;
      const stats = execution.pending;
      execution.pending = undefined;
      if (!stats || execution.stop) continue;
      const task = this.find(id);
      changed.set(id, { ...task, ...stats });
      if (Date.now() - execution.lastSaved >= 2000) {
        execution.lastSaved = Date.now();
        void this.exclusive(async () => {
          if (this.active.get(id) === execution && !execution.stop)
            await this.save(this.find(id), true);
        }).catch((error: unknown) => this.publish({ error: describeError(error) }));
      }
    }
    if (changed.size)
      this.publish({ tasks: this.snapshot.tasks.map((task) => changed.get(task.id) ?? task) });
  }
  private async execute(id: string, execution: Execution) {
    let failure: unknown;
    try {
      await this.engine.run(
        this.find(id),
        this.snapshot.settings,
        execution.controller.signal,
        (update) => this.progress(id, execution, update),
        (phase, inputs) =>
          this.exclusive(async () => {
            execution.controller.signal.throwIfAborted();
            this.flushProgress(id, execution);
            const task = this.find(id);
            await this.save({
              ...task,
              phase,
              inputs: inputs ?? task.inputs,
              status: phase === "merge" ? "merging" : "downloading",
              progress: null,
              speed: 0,
            });
          }),
      );
    } catch (error) {
      failure = error;
    }
    try {
      await this.exclusive(async () => {
        this.flushProgress(id, execution);
        const task = this.find(id);
        if (failure instanceof StopUnconfirmedError) {
          this.uncertainStops.set(id, failure);
          this.publish({ error: failure.message });
        }
        const status =
          failure instanceof StopUnconfirmedError
            ? "failed"
            : (execution.stop ?? (failure ? "failed" : "completed"));
        await this.save({
          ...task,
          status,
          speed: 0,
          progress: status === "completed" ? 100 : task.progress,
          error:
            failure && (!execution.stop || failure instanceof StopUnconfirmedError)
              ? redactLog(describeError(failure), task)
              : "",
        });
      });
    } catch (error) {
      this.publish({ error: describeError(error) });
    } finally {
      this.active.delete(id);
      if (!this.active.size) {
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
      }
      execution.finish();
      this.pump();
    }
  }
  private async stop(id: string, status: "paused" | "cancelled") {
    if (this.recovery) throw new Error("正在恢复下载服务，请稍候。");
    let execution: Execution | undefined;
    await this.exclusive(async () => {
      const uncertain = this.uncertainStops.get(id);
      if (uncertain) {
        await uncertain.retry();
        this.uncertainStops.delete(id);
        if (!this.uncertainStops.size && this.snapshot.error === uncertain.message)
          this.publish({ error: "" });
      }
      const task = this.find(id);
      execution = this.active.get(id);
      if (execution) {
        this.flushProgress(id, execution);
        execution.stop = status;
        execution.controller.abort();
      } else if (task.status !== "completed") {
        await this.save({ ...task, status, speed: 0 });
      }
    });
    await execution?.done;
    if (this.uncertainStops.has(id)) throw this.uncertainStops.get(id);
    if (isRunning(this.find(id).status))
      throw new Error(this.snapshot.error || "任务状态保存失败，请重试停止。");
  }
  pause(id: string) {
    return this.stop(id, "paused");
  }
  cancel(id: string) {
    return this.stop(id, "cancelled");
  }
  async pauseAll() {
    await Promise.all(
      this.snapshot.tasks
        .filter(
          (task) =>
            isRunning(task.status) || task.status === "queued" || this.uncertainStops.has(task.id),
        )
        .map((task) => this.pause(task.id)),
    );
  }
  async resume(id: string) {
    if (this.uncertainStops.has(id)) await this.stop(id, "paused");
    await this.exclusive(async () => {
      this.requireReady();
      const task = this.find(id);
      if (this.active.has(id)) throw new Error("正在停止任务，请稍候。");
      if (task.rename) throw new Error("请先在修改任务中完成上次改名。");
      if (!canResume(task.status)) return;
      await this.save({ ...task, status: "queued", error: "", speed: 0 });
    });
    this.pump();
  }
  async remove(id: string) {
    await this.cancel(id);
    await this.exclusive(async () => {
      const task = this.find(id);
      await this.repository.remove(id, task.revision);
      this.publish({ tasks: this.snapshot.tasks.filter((item) => item.id !== id) });
    });
  }
  async shutdown(beforeDatabaseClose?: () => Promise<void>) {
    await this.recovery?.catch(() => {});
    this.stopping = true;
    this.repository.beginShutdown?.();
    try {
      await this.pauseAll();
      await Promise.all(this.handoffs);
      await this.serial;
      // 下载已停止，但其他服务仍要通过同一扩展保存状态和停止媒体库任务。
      await beforeDatabaseClose?.();
      await this.repository.close();
    } catch (error) {
      this.stopping = false;
      throw error;
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return typeof error === "string" ? error : "操作失败，请重试。";
}
