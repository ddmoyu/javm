import type { DownloadTask } from "../../contracts/downloads";
import { activeScrape } from "../../contracts/scraping";
import type { ScrapeTask, ScrapePhase } from "../../contracts/scraping";
import type { MovieCandidate, MovieDetails } from "../metadata/MetaTubeService";
import { Observable, serviceError } from "../metadata/shared";
import { logEvent } from "../logging/events";
import { identifyCode, normalizeCode } from "./identity";
import { mergeScrapeHistory, sameScrapeTarget, scrapeTarget } from "./taskIdentity";
import { StopUnconfirmedError } from "../downloads/ports";
import type { MetadataPipeline } from "./MetadataPipeline";
import type { ResolvedMovie } from "../metadata/MovieMetadataResolver";
import { MetadataQueryError } from "../metadata/diagnostics";
import type { MetadataDiagnostics, MetadataQueryOptions } from "../metadata/diagnostics";
import { reportFailure } from "../feedback/events";

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
  search(
    query: string,
    signal: AbortSignal,
    options?: MetadataQueryOptions,
  ): Promise<MovieCandidate[]>;
  details(
    candidate: MovieCandidate,
    signal: AbortSignal,
    options?: MetadataQueryOptions,
  ): Promise<MovieDetails>;
  resolve?(
    candidate: MovieCandidate,
    signal: AbortSignal,
    options?: MetadataQueryOptions,
  ): Promise<ResolvedMovie>;
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
  pipeline?: MetadataPipeline;
  private serial: Promise<unknown> = Promise.resolve();
  private initialization?: Promise<void>;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private stopping = false;
  async relocateDownload(
    downloadId: string,
    from: string,
    to: string,
    operation: () => Promise<void>,
  ) {
    await this.initialize();
    return this.exclusive(async () => {
      const jobs = this.snapshot.tasks.filter(
        (task) => task.downloadId === downloadId || task.path === from,
      );
      if (jobs.some(activeScrape)) throw new Error("请等待或取消此文件的刮削任务后再改名。");
      await operation();
      for (const task of jobs) await this.write({ ...task, path: to });
    });
  }
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
    private recognize?: (
      filename: string,
      title: string,
      signal: AbortSignal,
    ) => Promise<string | undefined>,
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
        await this.mergeRestoredTasks();
        for (const task of this.snapshot.tasks)
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
  private async write(task: ScrapeTask, metadata?: MetadataDiagnostics) {
    const previous = this.snapshot.tasks.find((item) => item.id === task.id);
    const next = { ...task, revision: task.revision + 1, updatedAt: new Date().toISOString() };
    await this.port.save(next, task.revision);
    const exists = this.snapshot.tasks.some((item) => item.id === task.id);
    this.publish({
      tasks: exists
        ? this.snapshot.tasks.map((item) => (item.id === task.id ? next : item))
        : [...this.snapshot.tasks, next],
    });
    if (previous?.status !== task.status && ["failed", "partial"].includes(task.status)) {
      const reproduction = {
        action: "scrape",
        code: task.candidate?.code,
        query: task.query,
        source: task.candidate?.provider,
        sourceId: task.candidate?.id,
        filePath: task.path,
      };
      logEvent(
        "error",
        "scraping",
        task.status,
        task.error || "刮削未能完整完成",
        {
          taskId: task.id,
          phase: task.phase,
          ...(metadata ? { queryId: metadata.queryId, reported: true } : {}),
        },
        reproduction,
      );
      if (metadata)
        reportFailure({
          module: "scraping",
          title: "刮削失败",
          message: task.error,
          taskId: task.id,
          details: { phase: task.phase, queryId: metadata.queryId },
          metadata,
          reproduction,
        });
    }
  }
  private async discard(task: ScrapeTask) {
    await this.port.remove(task);
    this.publish({ tasks: this.snapshot.tasks.filter((item) => item.id !== task.id) });
  }
  private async mergeRestoredTasks() {
    type Group = {
      task: ScrapeTask;
      target: ReturnType<typeof scrapeTarget>;
      duplicates: ScrapeTask[];
      order: number;
    };
    const groups: Group[] = [];
    for (const [index, task] of this.snapshot.tasks.entries()) {
      let group: Group = { task, target: scrapeTarget(task), duplicates: [], order: index };
      for (let merged = 0; ; merged++) {
        const match = groups.findIndex((item) => sameScrapeTarget(item.target, group.target));
        if (match < 0) break;
        const previous = groups.splice(match, 1)[0]!;
        const [keep, other] = previous.order < group.order ? [previous, group] : [group, previous];
        const task = mergeScrapeHistory(keep.task, other.task);
        group = {
          task,
          target: scrapeTarget(task),
          duplicates: [...keep.duplicates, ...other.duplicates, other.task],
          order: keep.order,
        };
        // 新得到的作品身份可能连接之前尚未匹配的来源任务，继续合并。
        if (merged % 25 === 24) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      groups.push(group);
      if (index % 25 === 24) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    for (const { task, duplicates } of groups.sort((left, right) => left.order - right.order)) {
      if (!duplicates.length) continue;
      // 先保存合并结果，再移除多余任务；中途失败可在下次启动继续，不触碰媒体文件。
      await this.write(task);
      for (const duplicate of duplicates) await this.discard(duplicate);
    }
  }
  private async mergeResolvedTasks(id: string) {
    const task = this.find(id);
    const target = scrapeTarget(task);
    const duplicates = this.snapshot.tasks.filter(
      (item) => item.id !== id && sameScrapeTarget(scrapeTarget(item), target),
    );
    if (!duplicates.length) return;
    const active = duplicates.find((item) => item.id === this.active?.id);
    if (active) {
      await this.mergeResolvedTasks(active.id);
      return;
    }
    // 来源候选经 prepare 才得到片库 ID；此时也吸收已存在的任务，避免再执行一次。
    await this.write({
      ...task,
      downloadId: task.downloadId || duplicates.find((item) => item.downloadId)?.downloadId,
      collect: task.collect || duplicates.some((item) => item.collect),
    });
    for (const duplicate of duplicates) await this.discard(duplicate);
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
      const target = scrapeTarget(input);
      const existing = this.snapshot.tasks.find((task) =>
        sameScrapeTarget(scrapeTarget(task), target),
      );
      if (existing) {
        // 下载回调幂等；手动重新添加已结束任务则在原行重试。
        if (!input.downloadId && !activeScrape(existing)) {
          if (this.active?.id === existing.id) throw new Error("当前任务正在收尾，请稍候。");
          const query = input.query?.trim();
          await this.write({
            ...existing,
            ...input,
            collect: input.collect || existing.collect,
            query: query || existing.query,
            candidate: input.candidate ?? (query ? undefined : existing.candidate),
            status: "queued",
            phase: "prepare",
            error: "",
          });
        } else if (input.collect && !existing.collect) {
          await this.write({ ...existing, collect: true });
        }
        return existing.id;
      }
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
    await this.exclusive(async () => {
      await this.write({ ...this.find(id), ...patch, status: "running", phase, error: "" });
      if (patch.workId || patch.candidate) await this.mergeResolvedTasks(id);
    });
    signal.throwIfAborted();
  }
  private async execute(id: string, signal: AbortSignal) {
    let image: Awaited<ReturnType<ScrapePort["artwork"]>> | undefined;
    let warning = "";
    try {
      await this.stage(id, "prepare", signal);
      const preparing = this.find(id);
      const target = await this.port.prepare(preparing, signal);
      const task = this.find(id);
      let query =
        task.query?.trim() ||
        target.code ||
        identifyCode(target.path.split(/[\\/]/).at(-1) ?? "") ||
        identifyCode(task.name);
      await this.stage(id, "search", signal, { workId: target.id, path: target.path, query });
      if (!query && !task.candidate && this.recognize) {
        try {
          query = await this.recognize(
            target.path.split(/[\\/]/).at(-1) ?? task.name,
            target.title,
            signal,
          );
          signal.throwIfAborted();
          if (query) await this.stage(id, "search", signal, { query });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof StopUnconfirmedError) throw error;
          throw new NeedsInput(`自动识别未完成：${serviceError(error)}`);
        }
      }
      if (!query && !task.candidate)
        throw new NeedsInput("未能识别唯一番号，请填写番号或手动选择来源结果。");
      let candidate = task.candidate;
      if (!candidate) {
        const results = await this.provider.search(query!, signal, { taskId: id });
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
      const resolved = this.provider.resolve
        ? await this.provider.resolve(candidate, signal, { taskId: id })
        : { candidate, details: await this.provider.details(candidate, signal, { taskId: id }) };
      if (normalizeCode(resolved.candidate.code) !== normalizeCode(candidate.code))
        throw new NeedsInput("后备资料番号与候选不一致，请重新确认。");
      const sourceChanged =
        resolved.candidate.provider !== candidate.provider ||
        resolved.candidate.id !== candidate.id;
      candidate = resolved.candidate;
      const details = resolved.details;
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
      if (sourceChanged) await this.stage(id, "details", signal, { candidate });
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
      await this.exclusive(async () => {
        const task = this.find(id);
        // 运行中合入的收藏请求也要生效；按已确认的作品 ID 收藏，不重新获取资料和图片。
        if (task.collect && !preparing.collect) await this.port.prepare(task, signal);
        await this.write({ ...task, status: warning ? "partial" : "completed", error: warning });
      });
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
            : error instanceof NeedsInput ||
                (error instanceof MetadataQueryError && error.noResults)
              ? "needsInput"
              : "failed";
      const message =
        error instanceof StopUnconfirmedError
          ? this.snapshot.error
          : signal.aborted
            ? "刮削已停止，已下载的视频及已保存资料保留。"
            : serviceError(error);
      await this.exclusive(() =>
        this.write(
          { ...this.find(id), status, error: message },
          error instanceof MetadataQueryError ? error.diagnostics : undefined,
        ),
      );
      if (!signal.aborted && status === "needsInput")
        logEvent("warn", "scraping", status, message, { taskId: id });
    } finally {
      await image?.dispose().catch(() => {});
      await this.port.refresh().catch(() => {});
    }
  }
  async retry(id: string, query?: string, candidate?: MovieCandidate) {
    await this.initialize();
    await this.exclusive(async () => {
      await this.finishUncertainStop();
      this.requireReady();
      const task = this.find(id);
      if (activeScrape(task)) return;
      if (this.active?.id === id) throw new Error("当前任务正在收尾，请稍候。");
      await this.write({
        ...task,
        query: query?.trim() || task.query,
        candidate: candidate ?? (query ? undefined : task.candidate),
        status: "queued",
        phase: "prepare",
        error: "",
      });
      await this.mergeResolvedTasks(id);
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
  async remove(id: string, onlyFailed = false) {
    return this.exclusive(async () => {
      if (this.stopping) throw new Error("应用正在退出。");
      if (this.uncertainStop?.id === id) throw new Error("请先重试以确认资料请求进程已停止。");
      const task = this.find(id);
      if (onlyFailed && task.status !== "failed") return false;
      if (activeScrape(task) || this.active?.id === id) throw new Error("请先停止刮削任务。");
      await this.discard(task);
      return true;
    });
  }
  async removeMany(
    ids: readonly string[],
    options: {
      onlyFailed?: boolean;
      signal?: AbortSignal;
      onProgress?: (completed: number, total: number) => void;
    } = {},
  ) {
    await this.initialize();
    const targets = [...new Set(ids)];
    let removed = 0;
    let completed = 0;
    let error = "";
    for (const id of targets) {
      if (options.signal?.aborted || this.stopping) break;
      try {
        // 每条记录沿用版本校验与运行中保护，失败项保留并继续处理其余记录。
        if (await this.remove(id, options.onlyFailed)) removed++;
      } catch (reason) {
        error ||= serviceError(reason);
      }
      completed++;
      if (completed % 20 === 0) {
        options.onProgress?.(completed, targets.length);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    options.onProgress?.(completed, targets.length);
    return { removed, retained: targets.length - removed, error };
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
