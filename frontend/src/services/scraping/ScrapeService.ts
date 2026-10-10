import type { DownloadTask } from "../../contracts/downloads";
import { activeScrape } from "../../contracts/scraping";
import type { ScrapeTask, ScrapePhase } from "../../contracts/scraping";
import type { MovieCandidate, MovieDetails } from "../metadata/MetaTubeService";
import { Observable, serviceError } from "../metadata/shared";
import { logEvent } from "../logging/events";
import { identifyCode, normalizeCode } from "./identity";
import { StopUnconfirmedError } from "../downloads/ports";

export interface ScrapeTarget {
  id: string;
  path: string;
  fileStamp: string;
  nfoStamp?: string;
  code: string;
  title: string;
  hasArtwork: boolean;
  jobId?: string;
}
export interface ScrapePort {
  load(offset: number): Promise<ScrapeTask[]>;
  save(task: ScrapeTask, expectedRevision: number): Promise<void>;
  remove(task: ScrapeTask): Promise<void>;
  prepare(task: ScrapeTask, signal: AbortSignal): Promise<ScrapeTarget>;
  artwork(
    details: MovieDetails,
    signal: AbortSignal,
  ): Promise<{ path: string; dispose(): Promise<void> }>;
  commit(
    task: ScrapeTask,
    target: ScrapeTarget,
    details: MovieDetails,
    image: string,
  ): Promise<{ warning?: string }>;
  refresh(): Promise<void>;
}
export interface ScrapeProvider {
  search(query: string, signal: AbortSignal): Promise<MovieCandidate[]>;
  details(candidate: MovieCandidate, signal: AbortSignal): Promise<MovieDetails>;
}
class NeedsInput extends Error {}
const limit = 1000;

export class ScrapeService extends Observable<{
  tasks: ScrapeTask[];
  ready: boolean;
  available: boolean;
  paused: boolean;
  error: string;
}> {
  private serial: Promise<unknown> = Promise.resolve();
  private initialization?: Promise<void>;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private stopping = false;
  private uncertainStop?: { id: string; error: StopUnconfirmedError };
  private async finishUncertainStop() {
    if (!this.uncertainStop) return;
    await this.uncertainStop.error.retry();
    this.uncertainStop = undefined;
    this.publish({ error: "" });
  }
  constructor(
    private port: ScrapePort,
    private provider: ScrapeProvider,
    available = true,
  ) {
    super({ tasks: [], ready: false, available, paused: false, error: "" });
  }
  private exclusive<T>(operation: () => Promise<T>) {
    const pending = this.serial.then(operation);
    this.serial = pending.catch(() => {});
    return pending;
  }
  initialize() {
    return (this.initialization ??= this.exclusive(async () => {
      if (!this.snapshot.available) {
        this.publish({ ready: true });
        return;
      }
      try {
        const tasks: ScrapeTask[] = [];
        for (let offset = 0; ; offset += 100) {
          const page = await this.port.load(offset);
          tasks.push(...page);
          if (tasks.length > limit) throw new Error("刮削记录超过上限，请先清理已完成记录。");
          if (page.length < 100) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        this.publish({ tasks });
        for (const task of tasks)
          if (activeScrape(task))
            await this.write({
              ...task,
              status: "interrupted",
              error: "上次刮削未完成，确认后可继续。",
            });
        this.publish({ ready: true });
      } catch (error) {
        this.publish({ ready: true, error: serviceError(error) });
      }
    }));
  }
  private find(id: string) {
    const task = this.snapshot.tasks.find((item) => item.id === id);
    if (!task) throw new Error("刮削任务已不存在。");
    return task;
  }
  private async write(task: ScrapeTask) {
    const next = { ...task, revision: task.revision + 1, updatedAt: new Date().toISOString() };
    await this.port.save(next, task.revision);
    const exists = this.snapshot.tasks.some((item) => item.id === task.id);
    this.publish({
      tasks: exists
        ? this.snapshot.tasks.map((item) => (item.id === task.id ? next : item))
        : [...this.snapshot.tasks, next],
    });
  }
  private requireReady() {
    if (!this.snapshot.available) throw new Error("请在 Windows 桌面应用中刮削。");
    if (this.stopping) throw new Error("应用正在退出。");
    if (!this.snapshot.ready || this.snapshot.error)
      throw new Error(this.snapshot.error || "正在读取刮削任务。");
  }
  async enqueue(input: {
    workId?: string;
    collect?: boolean;
    path?: string;
    name: string;
    downloadId?: string;
    query?: string;
    candidate?: MovieCandidate;
  }) {
    await this.initialize();
    const id = await this.exclusive(async () => {
      this.requireReady();
      const existing = this.snapshot.tasks.find((task) =>
        input.downloadId
          ? task.downloadId === input.downloadId
          : activeScrape(task) &&
            ((input.workId && task.workId === input.workId) ||
              (input.path && task.path === input.path) ||
              (input.candidate &&
                task.candidate?.provider === input.candidate.provider &&
                task.candidate?.id === input.candidate.id)),
      );
      if (existing) return existing.id;
      if (this.snapshot.tasks.length >= limit)
        throw new Error("最多保留 1000 个刮削任务，请先清理已结束记录。");
      if (!input.workId && !input.path && !input.candidate)
        throw new Error("请选择作品、视频或来源结果。");
      const now = new Date().toISOString();
      const task: ScrapeTask = {
        ...input,
        id: crypto.randomUUID(),
        revision: 0,
        status: "queued",
        phase: "prepare",
        error: "",
        createdAt: now,
        updatedAt: now,
      };
      await this.write(task);
      return task.id;
    });
    this.pump();
    return id;
  }
  enqueueDownload = (download: DownloadTask) =>
    this.enqueue({
      workId: download.workId,
      path: download.output,
      name: download.name,
      downloadId: download.id,
    });
  private pump() {
    if (
      this.active ||
      this.stopping ||
      this.snapshot.paused ||
      this.snapshot.error ||
      !this.snapshot.ready
    )
      return;
    const task = this.snapshot.tasks.find((item) => item.status === "queued");
    if (!task) return;
    const abort = new AbortController();
    const done = Promise.resolve().then(() => this.execute(task.id, abort.signal));
    this.active = { id: task.id, abort, done };
    void done
      .catch((error: unknown) => this.publish({ error: serviceError(error) }))
      .finally(() => {
        this.active = undefined;
        this.pump();
      });
  }
  private async stage(
    id: string,
    phase: ScrapePhase,
    signal: AbortSignal,
    patch: Partial<ScrapeTask> = {},
  ) {
    signal.throwIfAborted();
    await this.exclusive(() =>
      this.write({ ...this.find(id), ...patch, status: "running", phase, error: "" }),
    );
    signal.throwIfAborted();
  }
  private async execute(id: string, signal: AbortSignal) {
    let image: Awaited<ReturnType<ScrapePort["artwork"]>> | undefined;
    let warning = "";
    try {
      await this.stage(id, "prepare", signal);
      const target = await this.port.prepare(this.find(id), signal);
      const task = this.find(id);
      await this.stage(id, "search", signal, { workId: target.id, path: target.path });
      const query =
        task.query?.trim() ||
        target.code ||
        identifyCode(target.path.split(/[\\/]/).at(-1) ?? "") ||
        identifyCode(task.name);
      if (!query && !task.candidate)
        throw new NeedsInput("未能识别唯一番号，请填写番号或手动选择来源结果。");
      let candidate = task.candidate;
      if (!candidate) {
        const results = await this.provider.search(query!, signal);
        const exact = results.filter((item) => normalizeCode(item.code) === normalizeCode(query!));
        if (!exact.length)
          throw new NeedsInput("没有找到番号一致的资料，请确认番号或在搜索结果中手动选择。");
        // 多个来源的同一番号采用服务返回的优先顺序，同一来源有不同 ID 则不猜测。
        if (
          new Set(
            exact.filter((item) => item.provider === exact[0]!.provider).map((item) => item.id),
          ).size > 1
        )
          throw new NeedsInput("同一来源返回多个不同作品，请手动选择正确结果。");
        candidate = exact[0]!;
      }
      await this.stage(id, "details", signal, { candidate });
      const details = await this.provider.details(candidate, signal);
      if (
        !details.fields.title ||
        !details.fields.code ||
        details.provider !== candidate.provider ||
        details.id !== candidate.id ||
        normalizeCode(details.fields.code) !== normalizeCode(candidate.code)
      )
        throw new NeedsInput("详情番号与候选不一致或资料不完整，请重新确认。");
      if (target.code && normalizeCode(target.code) !== normalizeCode(details.fields.code))
        throw new NeedsInput("片库番号与来源不一致，请先在影片编辑中确认番号。");
      if (!target.hasArtwork) {
        await this.stage(id, "artwork", signal);
        try {
          image = await this.port.artwork(details, signal);
        } catch (error) {
          if (error instanceof StopUnconfirmedError) throw error;
          signal.throwIfAborted();
          warning = `封面未保存：${serviceError(error)}`;
        }
      }
      await this.stage(id, "save", signal);
      // 保存为不可拆分的提交阶段；取消/退出等待这一阶段收尾。
      const saved = await this.port.commit(this.find(id), target, details, image?.path ?? "");
      warning = [warning, saved.warning].filter(Boolean).join("；");
      await this.exclusive(() =>
        this.write({ ...this.find(id), status: warning ? "partial" : "completed", error: warning }),
      );
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        this.uncertainStop = { id, error };
        this.publish({
          error: "资料请求进程尚未确认停止，队列已停止调度。请重试刮削以先完成清理。",
        });
      }
      const status =
        error instanceof StopUnconfirmedError
          ? "failed"
          : signal.aborted
            ? this.stopping
              ? "interrupted"
              : "cancelled"
            : error instanceof NeedsInput
              ? "needsInput"
              : "failed";
      const message =
        error instanceof StopUnconfirmedError
          ? this.snapshot.error
          : signal.aborted
            ? "刮削已停止，已下载的视频及已保存资料保留。"
            : serviceError(error);
      await this.exclusive(() => this.write({ ...this.find(id), status, error: message }));
      if (!signal.aborted) logEvent("warn", "scraping", status, message, { taskId: id });
    } finally {
      await image?.dispose().catch(() => {});
      await this.port.refresh().catch(() => {});
    }
  }
  async retry(id: string, query?: string, candidate?: MovieCandidate) {
    await this.exclusive(async () => {
      await this.finishUncertainStop();
      this.requireReady();
      if (this.active?.id === id) throw new Error("当前任务正在收尾，请稍候。");
      await this.write({
        ...this.find(id),
        query: query?.trim() || this.find(id).query,
        candidate: candidate ?? (query ? undefined : this.find(id).candidate),
        status: "queued",
        phase: "prepare",
        error: "",
      });
    });
    this.pump();
  }
  async cancel(id: string) {
    const active = this.active?.id === id ? this.active : undefined;
    if (active) {
      if (this.find(id).phase !== "save") active.abort.abort();
      await active.done;
    } else
      await this.exclusive(async () => {
        const task = this.find(id);
        if (task.status === "queued") await this.write({ ...task, status: "cancelled", error: "" });
      });
  }
  pauseQueue(paused: boolean) {
    this.publish({ paused });
    if (!paused) this.pump();
  }
  async remove(id: string) {
    await this.exclusive(async () => {
      if (this.uncertainStop?.id === id) throw new Error("请先重试以确认资料请求进程已停止。");
      const task = this.find(id);
      if (activeScrape(task) || this.active?.id === id) throw new Error("请先停止刮削任务。");
      await this.port.remove(task);
      this.publish({ tasks: this.snapshot.tasks.filter((item) => item.id !== id) });
    });
  }
  async shutdown() {
    this.stopping = true;
    try {
      if (this.active && this.find(this.active.id).phase !== "save") this.active.abort.abort();
      await this.active?.done;
      await this.serial;
      await this.finishUncertainStop();
    } catch (error) {
      this.stopping = false;
      throw error;
    }
  }
}
