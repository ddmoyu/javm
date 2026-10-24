import type { LogService } from "../logging/LogService";
import { cleanLog } from "../logging/events";
import type { LogEntry } from "../logging/events";
import type { FailureInput } from "./events";
import { cleanMetadataDiagnostics } from "../metadata/diagnostics";
import { cleanReproduction } from "../logging/reproduction";
import {
  diagnosticText,
  failureFromLog,
  feedbackPolicy,
  feedbackUrl,
  formatReport,
  issuesUrl,
  logExcerpt,
  logLine,
  relatedLog,
} from "./report";
import type { FailureReport, SystemDetails } from "./report";

export interface FeedbackSession {
  id: string;
  startedAt: string;
  clean: boolean;
  system: SystemDetails;
}
export interface FeedbackState {
  schema: 1;
  session: FeedbackSession;
  reports: FailureReport[];
}
export interface FeedbackPort {
  settings?: {
    read(): Promise<unknown>;
    write(value: { enabled: boolean }): Promise<void>;
  };
  startup?(): Promise<void>;
  listen?(): () => void;
  read(): Promise<unknown>;
  begin?(session: FeedbackSession): Promise<void>;
  end?(): Promise<void>;
  warning?(): string;
  write(state: FeedbackState): Promise<void>;
  system(): Promise<SystemDetails>;
  copy(text: string): Promise<void>;
  open(url: string): Promise<void>;
}

export async function deadline<T>(work: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("诊断操作超时")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function cleanSystem(value: SystemDetails) {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 20)
      .filter(
        ([key, item]) =>
          typeof item === "string" && !/password|token|secret|cookie|authorization/i.test(key),
      )
      .map(([key, item]) => [diagnosticText(key, 40), diagnosticText(item, 300)]),
  );
}
function cleanInput(input: FailureInput): FailureInput {
  const context = cleanLog({
    level: "error",
    module: "feedback",
    event: "details",
    message: "",
    context: input.details,
  }).context;
  return {
    module: diagnosticText(input.module, 40),
    title: diagnosticText(input.title, 100),
    message: diagnosticText(input.message),
    ...(input.taskId ? { taskId: diagnosticText(input.taskId, 100) } : {}),
    ...(input.url ? { url: feedbackUrl(input.url) } : {}),
    ...(input.metadata ? { metadata: cleanMetadataDiagnostics(input.metadata) } : {}),
    ...(input.reproduction ? { reproduction: cleanReproduction(input.reproduction) } : {}),
    details: context
      ? Object.fromEntries(
          Object.entries(context).map(([key, value]) => [
            diagnosticText(key, 40),
            typeof value === "string" ? diagnosticText(value, 160) : value,
          ]),
        )
      : undefined,
  };
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
export function restoreFeedbackState(raw: unknown): FeedbackState | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") throw new Error("反馈记录格式无效");
  const state = raw as FeedbackState;
  if (
    state.schema !== 1 ||
    !state.session ||
    typeof state.session.id !== "string" ||
    !validTime(state.session.startedAt) ||
    typeof state.session.clean !== "boolean" ||
    !state.session.system ||
    typeof state.session.system !== "object" ||
    !Array.isArray(state.reports) ||
    state.reports.length > feedbackPolicy.reports
  )
    throw new Error("反馈记录格式无效");
  const reports = state.reports.map((item) => {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.session !== "string" ||
      !validTime(item.time) ||
      typeof item.module !== "string" ||
      typeof item.title !== "string" ||
      typeof item.message !== "string" ||
      typeof item.before !== "string" ||
      typeof item.after !== "string" ||
      !item.system ||
      typeof item.system !== "object"
    )
      throw new Error("反馈记录格式无效");
    return {
      ...cleanInput(item),
      id: item.id.slice(0, 100),
      session: item.session.slice(0, 100),
      time: item.time,
      count: Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1,
      before: diagnosticText(item.before, feedbackPolicy.before),
      after: diagnosticText(item.after, feedbackPolicy.after),
      complete: true,
      system: cleanSystem(item.system),
    };
  });
  return {
    schema: 1,
    session: { ...state.session, system: cleanSystem(state.session.system) },
    reports,
  };
}

export class FeedbackService {
  private snapshot: {
    reports: FailureReport[];
    activeId?: string;
    historyOpened: boolean;
    error: string;
    busy: boolean;
    enabled: boolean;
    settingsReady: boolean;
    savingSettings: boolean;
    settingsError: string;
  } = {
    reports: [],
    historyOpened: false,
    error: "",
    busy: false,
    enabled: true,
    settingsReady: false,
    savingSettings: false,
    settingsError: "",
  };
  private listeners = new Set<() => void>();
  private session: FeedbackSession;
  private initialized?: Promise<void>;
  private started?: Promise<void>;
  private settingsWork?: Promise<void>;
  private beginning?: Promise<void>;
  private generation = 0;
  private disposed = false;
  private ready = false;
  private persistence = true;
  private stopping = false;
  private dirty = false;
  private writing?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private maintenance?: ReturnType<typeof setInterval>;
  private collecting = new Map<string, ReturnType<typeof setTimeout>>();
  private systemWork?: Promise<SystemDetails>;
  private systemAt = 0;
  private lastPrompt = -Infinity;
  private unobserve?: () => void;
  private unlisten?: () => void;
  constructor(
    private logs: LogService,
    private port: FeedbackPort,
    private now = Date.now,
  ) {
    this.session = {
      id: logs.getSession(),
      startedAt: new Date(now()).toISOString(),
      clean: false,
      system: {},
    };
    // 持久化开关尚未读取时不订阅诊断，也不接受启动期间的反馈。
    this.snapshot.enabled = !port.settings;
    this.snapshot.settingsReady = !port.settings;
    if (!port.settings) this.unobserve = logs.observeEntries(this.onLog);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private update(id: string, patch: Partial<FailureReport>) {
    this.publish({
      reports: this.snapshot.reports.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
    this.scheduleSave();
  }
  private system() {
    if (!this.systemWork || this.now() - this.systemAt > 5000) {
      this.systemAt = this.now();
      this.systemWork = deadline(this.port.system()).then(cleanSystem, () => ({
        采集状态: "部分系统信息未能取得",
      }));
    }
    return this.systemWork;
  }
  initialize() {
    return (this.initialized ??= (async () => {
      if (this.port.settings) {
        try {
          const saved = await this.port.settings.read();
          if (
            saved !== null &&
            (typeof saved !== "object" ||
              !("enabled" in saved) ||
              typeof saved.enabled !== "boolean")
          )
            throw new Error("反馈设置格式无效");
          if (this.disposed) return;
          this.publish({ enabled: saved === null || saved.enabled === true, settingsReady: true });
        } catch {
          this.publish({
            enabled: false,
            settingsReady: true,
            settingsError: "无法读取反馈设置，反馈与崩溃记录暂未启用；请重新设置。",
          });
        }
      }
      if (this.snapshot.enabled && !this.disposed) await this.start();
    })());
  }
  async setEnabled(enabled: boolean) {
    if (this.settingsWork) throw new Error("正在保存反馈设置，请稍候。");
    this.publish({ savingSettings: true });
    this.settingsWork = (async () => {
      try {
        await this.initialize();
        if (this.disposed) return;
        try {
          await this.port.settings?.write({ enabled });
        } catch (error) {
          this.publish({ settingsError: "反馈设置保存失败，仍使用原设置，请重试。" });
          throw error;
        }
        const changed = enabled !== this.snapshot.enabled;
        this.publish({
          enabled,
          settingsError: "",
          ...(!enabled ? { activeId: undefined, historyOpened: false } : {}),
        });
        if (!changed) return;
        if (enabled) {
          // 重新开启从当前时刻开始，不追报关闭期间或遗留标记对应的异常退出。
          await this.start(false);
        } else {
          this.stopCollecting();
          this.started = undefined;
          this.systemWork = undefined;
          this.publish({
            reports: this.snapshot.reports.map((item) => ({ ...item, complete: true })),
          });
          try {
            // 已发出的写入可能仍会建立标记，必须等它结束后再清理。
            await this.beginning?.catch(() => {});
            await this.writing;
            await this.port.end?.();
          } catch {
            this.publish({
              settingsError: "反馈已关闭，但运行标记清理失败；重新开启时不会补报旧的异常退出。",
            });
          }
        }
      } finally {
        this.settingsWork = undefined;
        this.publish({ savingSettings: false });
      }
    })();
    return this.settingsWork;
  }
  private isActive(generation: number) {
    return !this.disposed && this.snapshot.enabled && this.generation === generation;
  }
  private start(recoverPrevious = true) {
    if (this.started) return this.started;
    const generation = ++this.generation;
    this.persistence = true;
    this.lastPrompt = -Infinity;
    this.session = { ...this.session, startedAt: new Date(this.now()).toISOString(), clean: false };
    return (this.started = (async () => {
      // 更新试运行的门闩不是 I/O 故障，不能按诊断超时禁用本次持久化。
      await this.port.startup?.();
      if (!this.isActive(generation)) return;
      this.unobserve ??= this.logs.observeEntries(this.onLog);
      this.unlisten ??= this.port.listen?.();
      try {
        const saved = restoreFeedbackState(await deadline(this.port.read()));
        if (!this.isActive(generation)) return;
        // 在采集系统信息、旧日志之前留下独立标记，初始化期间退出也可恢复。
        try {
          this.beginning = this.port.begin?.(this.session) ?? Promise.resolve();
          await deadline(this.beginning);
        } catch {
          // 标记写入暂时失败不代表历史不可读；下一次快照写入会重试建立标记。
          this.publish({ error: "运行标记保存失败，本次反馈仍可复制；保存诊断时将重试。" });
        }
        if (!this.isActive(generation)) return;
        if (this.port.warning?.()) this.publish({ error: this.port.warning() });
        if (saved) {
          const reports = new Map(
            [...saved.reports, ...this.snapshot.reports].map((item) => [item.id, item]),
          );
          this.publish({ reports: this.prune([...reports.values()]) });
          if (recoverPrevious && !saved.session.clean) {
            const recent = await deadline(this.logs.recent()).catch(() => []);
            if (!this.isActive(generation)) return;
            const previous = recent
              .filter((entry) => entry.session === saved.session.id)
              .sort((a, b) => a.sequence - b.sequence);
            const id = this.capture({
              module: "app",
              title: "上次未正常退出",
              message: `上次会话开始于 ${saved.session.startedAt}，没有留下正常退出标记。可能是程序崩溃、强制结束或断电；仅凭该标记无法确定原因。${previous.at(-1) ? `最后可用日志时间：${previous.at(-1)!.time}。` : "没有找到上次会话日志。"}`,
            });
            if (id) {
              this.finish(id);
              this.update(id, {
                session: saved.session.id,
                system: saved.session.system,
                before: logExcerpt(previous),
                after: "",
              });
            }
          }
        }
      } catch {
        // 不能把无法读取当成空记录并覆盖，反馈仍可以只在内存中使用。
        this.persistence = false;
        this.publish({
          error: "历史反馈无法读取，原文件已保留。本次反馈仍可复制，但无法保存到下次启动。",
        });
      }
      if (!this.isActive(generation)) return;
      const system = await this.system();
      if (!this.isActive(generation)) return;
      this.session.system = system;
      this.ready = true;
      this.scheduleSave();
      this.maintenance = setInterval(() => {
        const reports = this.prune(this.snapshot.reports);
        if (reports.length === this.snapshot.reports.length) return;
        this.publish({
          reports,
          activeId: reports.some((item) => item.id === this.snapshot.activeId)
            ? this.snapshot.activeId
            : undefined,
        });
        this.scheduleSave();
      }, 3600000);
    })());
  }
  private prune(reports: FailureReport[]) {
    const cutoff = this.now() - feedbackPolicy.days * 86400000;
    return reports
      .filter((item) => Date.parse(item.time) >= cutoff)
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, feedbackPolicy.reports);
  }
  capture = (input: FailureInput, open = false): string | undefined => {
    if (!this.snapshot.enabled || this.disposed) return undefined;
    const generation = this.generation;
    const failure = cleanInput(input);
    const previous = this.snapshot.reports.find(
      (item) =>
        item.module === failure.module &&
        item.taskId === failure.taskId &&
        item.message === failure.message &&
        item.url === failure.url &&
        JSON.stringify(item.reproduction) === JSON.stringify(failure.reproduction) &&
        ((open && !failure.metadata) || item.metadata?.queryId === failure.metadata?.queryId) &&
        ((item.session === this.session.id && this.now() - Date.parse(item.time) < 60000) ||
          (open &&
            !!failure.taskId &&
            (item.time === input.occurredAt ||
              (failure.details?.taskRevision !== undefined &&
                item.details?.taskRevision === failure.details.taskRevision)))),
    );
    if (previous) {
      if (open) this.open(previous.id);
      else this.update(previous.id, { count: Math.min(previous.count + 1, 999999) });
      return previous.id;
    }
    const occurredAt = validTime(input.occurredAt)
      ? input.occurredAt
      : new Date(this.now()).toISOString();
    const historical = this.now() - Date.parse(occurredAt) > feedbackPolicy.followMs;
    const report: FailureReport = {
      ...failure,
      id: crypto.randomUUID(),
      session: this.session.id,
      time: occurredAt,
      count: 1,
      system: this.session.system,
      complete: historical,
      before: logExcerpt(
        this.logs
          .getRecentEntries()
          .filter((entry) => Date.parse(entry.time) <= Date.parse(occurredAt)),
        failure.taskId,
        undefined,
        failure.metadata?.queryId,
      ),
      after: "",
    };
    // 手动打开旧任务不能冒充已保存的旧系统快照。
    if (historical) report.system = { 采集状态: "任务失败时未保存系统信息，以下为本次反馈时采集" };
    const reports = [report, ...this.prune(this.snapshot.reports)].slice(0, feedbackPolicy.reports);
    const active = this.snapshot.reports.find((item) => item.id === this.snapshot.activeId);
    if (active && !open && !reports.some((item) => item.id === active.id))
      reports[reports.length - 1] = active;
    for (const [id, timer] of this.collecting) {
      if (!reports.some((item) => item.id === id)) {
        clearTimeout(timer);
        this.collecting.delete(id);
      }
    }
    const shouldOpen =
      open ||
      (!this.stopping &&
        !this.snapshot.historyOpened &&
        !this.snapshot.activeId &&
        this.now() - this.lastPrompt >= 30000);
    if (shouldOpen) this.lastPrompt = this.now();
    this.publish({ reports, ...(shouldOpen ? { activeId: report.id } : {}) });
    if (!historical)
      this.collecting.set(
        report.id,
        setTimeout(() => this.finish(report.id), feedbackPolicy.followMs),
      );
    void this.system().then((system) => {
      if (!this.isActive(generation)) return;
      const current = this.snapshot.reports.find((item) => item.id === report.id);
      if (current?.session === this.session.id)
        this.update(report.id, { system: { ...report.system, ...system } });
    });
    this.scheduleSave();
    return report.id;
  };
  private onLog = (entry: LogEntry) => {
    if (!this.snapshot.enabled || this.disposed) return;
    for (const id of this.collecting.keys()) {
      const report = this.snapshot.reports.find((item) => item.id === id);
      if (!report || !relatedLog(entry, report.taskId, report.metadata?.queryId)) continue;
      const line = logLine(entry);
      if (report.after.length + line.length + 1 <= feedbackPolicy.after)
        this.update(id, { after: [report.after, line].filter(Boolean).join("\n") });
    }
    if (this.stopping) return;
    const failure = failureFromLog(entry);
    if (failure) this.capture(failure);
  };
  private finish(id: string) {
    clearTimeout(this.collecting.get(id));
    this.collecting.delete(id);
    this.update(id, { complete: true });
  }
  open = (id: string | undefined) => {
    if (!this.snapshot.enabled || this.disposed || !id) return;
    this.publish({ activeId: id });
  };
  openHistory = () => {
    if (!this.snapshot.enabled || this.disposed || this.snapshot.savingSettings) return;
    this.publish({ historyOpened: true, activeId: undefined });
  };
  closeHistory = () => {
    this.publish({ historyOpened: false, activeId: undefined });
  };
  dismiss = () => {
    this.publish({ activeId: undefined });
  };
  preview(id: string | undefined) {
    const report = this.snapshot.reports.find((item) => item.id === id);
    return report ? formatReport(report) : "";
  }
  async submit(id: string | undefined, openIssue = true) {
    if (this.snapshot.busy || !this.snapshot.enabled || this.disposed) return "";
    this.publish({ busy: true });
    try {
      const text = this.preview(id);
      if (!text) throw new Error("反馈记录已过期，请重新打开任务反馈。");
      try {
        await deadline(this.port.copy(text));
      } catch {
        throw new Error("复制失败，未打开 GitHub。请重试，或从下方预览手动复制。");
      }
      if (!this.snapshot.enabled || this.disposed) return "";
      if (openIssue) {
        try {
          await deadline(this.port.open(issuesUrl));
        } catch {
          return "反馈信息已放入剪贴板，但浏览器未能打开。请手动前往 GitHub Issues 粘贴提交。";
        }
      }
      return openIssue
        ? "反馈信息已放入剪贴板，已请求打开 GitHub Issues，粘贴提交即可。"
        : "反馈信息已放入剪贴板。";
    } finally {
      this.publish({ busy: false });
    }
  }
  private scheduleSave() {
    if (!this.snapshot.enabled || this.disposed) return;
    this.dirty = true;
    if (!this.ready || !this.persistence || this.saveTimer || this.writing) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 250);
  }
  private flush(): Promise<void> {
    if (this.writing) return this.writing;
    if (!this.ready || !this.persistence || !this.dirty) return Promise.resolve();
    this.dirty = false;
    const reports = this.prune(this.snapshot.reports);
    this.writing = this.port
      .write({ schema: 1, session: { ...this.session }, reports })
      .then(
        () => {
          if (this.snapshot.error) this.publish({ error: this.port.warning?.() ?? "" });
        },
        () => {
          this.publish({ error: "反馈记录保存失败，本次仍可复制。请检查磁盘空间和权限。" });
        },
      )
      .finally(() => {
        this.writing = undefined;
        if (this.dirty) this.scheduleSave();
      });
    return this.writing;
  }
  async prepareExit() {
    await this.settingsWork?.catch(() => {});
    this.stopping = true;
    if (this.snapshot.settingsReady && !this.snapshot.enabled) return;
    for (const id of [...this.collecting.keys()]) this.finish(id);
    await deadline(this.initialize()).catch(() => {});
    if (!this.snapshot.enabled) return;
    this.session.clean = true;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // 先等待旧写入，再保存正常退出标记，避免旧快照覆盖新标记。
    await deadline(
      (async () => {
        await this.writing;
        await this.flush();
      })(),
    ).catch(() => {});
  }
  async resumeAfterFailedExit() {
    this.stopping = false;
    if (!this.snapshot.enabled || this.disposed) return;
    this.session.clean = false;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // 等待退出时的旧写入结束后立即恢复标记，避免旧清理覆盖重新运行状态。
    await deadline(
      (async () => {
        await this.writing;
        await this.flush();
      })(),
    ).catch(() => {});
  }
  private stopCollecting() {
    ++this.generation;
    this.ready = false;
    this.dirty = false;
    this.unobserve?.();
    this.unobserve = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    clearInterval(this.maintenance);
    this.maintenance = undefined;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const timer of this.collecting.values()) clearTimeout(timer);
    this.collecting.clear();
  }
  dispose() {
    this.disposed = true;
    this.stopCollecting();
  }
}
