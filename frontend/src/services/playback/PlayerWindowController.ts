import { playbackError } from "./PlaybackService";
import type { PlaybackController, PlaybackSnapshot } from "./PlaybackService";
import type { PlaybackWindowMode } from "./PlaybackSettingsService";
import { playbackRequest, playbackSourceKey } from "./source";
import type { PlaybackOptions } from "./source";
import { playerChannelName } from "./windowChannel";
import type { PlayerCommand, PlayerWindowMessage } from "./windowChannel";
import type { PlaybackHistoryStore } from "./PlaybackHistory";
import { servePlaybackHistory } from "./historyChannel";
import { logEvent } from "../logging/events";

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Session {
  id: string;
  channel: BroadcastChannel;
  ready: Promise<void>;
  failed: (error: Error) => void;
  startup?: ReturnType<typeof setTimeout>;
  pending: Map<string, Pending>;
  heartbeat: ReturnType<typeof setInterval>;
  snapshot: PlaybackSnapshot;
  closeHistory?: () => void;
}

/** 主窗口只发送播放指令；媒体、挂载与传输进程全部属于播放器子窗口。 */
export class PlayerWindowController implements PlaybackController {
  private snapshot: PlaybackSnapshot = { opened: false, preparing: false, revision: 0 };
  private listeners = new Set<() => void>();
  // 插入顺序即打开顺序；关闭最近的窗口后回退到仍然存活的上一个窗口。
  private sessions = new Set<Session>();
  private operation?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  constructor(
    private launch: (id: string) => Promise<void>,
    private windowMode: () => PlaybackWindowMode = () => "reuse",
    private historyStore?: PlaybackHistoryStore,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(snapshot: PlaybackSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private latest() {
    return [...this.sessions].at(-1);
  }
  private updateSession(session: Session, snapshot: PlaybackSnapshot) {
    session.snapshot = snapshot;
    if (this.latest() === session) this.update(snapshot);
  }
  private disconnect(session: Session) {
    const wasLatest = this.latest() === session;
    if (!this.sessions.delete(session)) return;
    clearTimeout(session.startup);
    session.failed(new Error("播放器窗口已关闭。"));
    clearInterval(session.heartbeat);
    session.channel.close();
    session.closeHistory?.();
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("播放器窗口已关闭。"));
    }
    session.pending.clear();
    if (wasLatest)
      this.update(
        this.latest()?.snapshot ?? {
          opened: false,
          preparing: false,
          revision: this.snapshot.revision,
        },
      );
  }
  private createSession(snapshot: PlaybackSnapshot) {
    const id = crypto.randomUUID();
    const channel = new BroadcastChannel(playerChannelName(id));
    let ready!: () => void;
    let failed!: (error: Error) => void;
    let lastContact = performance.now();
    let lastTick = lastContact;
    const session: Session = {
      id,
      channel,
      pending: new Map(),
      ready: new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      }),
      failed: (error) => failed(error),
      snapshot,
      closeHistory: this.historyStore ? servePlaybackHistory(id, this.historyStore) : undefined,
      // 不传文件地址、令牌或任何大数据；最小化时也维持窗口归属。
      heartbeat: setInterval(() => {
        const now = performance.now();
        // 休眠恢复或后台计时器节流之后，重新给对端响应时间。
        if (now - lastTick > 15000) lastContact = now;
        lastTick = now;
        if (now - lastContact > 120000) {
          logEvent(
            "error",
            "playback",
            "window_disconnected",
            "播放器窗口超过 120 秒未响应，连接已断开。可能是子窗口异常退出或长时间无响应。",
            { windowId: id },
          );
          this.disconnect(session);
          return;
        }
        channel.postMessage({ type: "ping" });
      }, 5000),
    };
    this.sessions.add(session);
    session.startup = setTimeout(() => {
      logEvent("error", "playback", "window_startup_failed", "播放器窗口启动超时，请重试。", {
        windowId: id,
      });
      failed(new Error("播放器窗口启动超时，请重试。"));
      this.disconnect(session);
    }, 20000);
    channel.onmessage = ({ data }: MessageEvent<PlayerWindowMessage>) => {
      if (!this.sessions.has(session)) return;
      lastContact = performance.now();
      if (data.type === "log") {
        const input = data.input;
        if (input && typeof input.message === "string")
          logEvent(input.level, "playback", input.event, input.message, {
            ...input.context,
            windowId: id,
          });
      } else if (data.type === "ready") {
        clearTimeout(session.startup);
        channel.postMessage({ type: "ping" });
        ready();
      } else if (data.type === "state") {
        this.updateSession(session, data.snapshot);
      } else if (data.type === "result") {
        const pending = session.pending.get(data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve();
      } else if (data.type === "closed") {
        clearTimeout(session.startup);
        failed(new Error("播放器窗口已关闭。"));
        // 关闭确认也完成正在等待的 close 指令。
        const pending = session.pending.get("close");
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve();
          session.pending.delete("close");
        }
        this.disconnect(session);
      }
    };
    void Promise.resolve()
      .then(() => this.launch(id))
      .catch((error: unknown) => {
        if (this.sessions.has(session))
          logEvent("error", "playback", "window_startup_failed", playbackError(error), {
            windowId: id,
          });
        failed(new Error(playbackError(error)));
        this.disconnect(session);
      });
    return session;
  }
  private command(session: Session, command: PlayerCommand) {
    if (!this.sessions.has(session)) return Promise.reject(new Error("播放器窗口已关闭。"));
    if (session.pending.size >= 2 && command.action !== "close")
      return Promise.reject(new Error("播放器正在处理操作，请稍后重试。"));
    const id = command.action === "close" ? "close" : crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        logEvent(
          "error",
          "playback",
          "window_command_failed",
          "播放器窗口没有响应，请关闭播放器后重试。",
          { windowId: session.id, action: command.action },
        );
        reject(new Error("播放器窗口没有响应，请关闭播放器后重试。"));
      }, 45000);
      session.pending.set(id, { resolve, reject, timer });
      session.channel.postMessage({ type: "command", id, command } satisfies PlayerWindowMessage);
    });
  }
  play(source: string, options?: PlaybackOptions) {
    return this.playInWindow(source, options, this.windowMode() === "reuse");
  }
  private async playInWindow(source: string, options: PlaybackOptions | undefined, reuse: boolean) {
    if (this.stopped) throw new Error("应用正在退出。");
    if (this.operation || this.closing) throw new Error("正在切换视频，请稍后重试。");
    const request = playbackRequest(source, options);
    const key = playbackSourceKey(request);
    const existing = [...this.sessions].find(
      (session) => session.snapshot.request && playbackSourceKey(session.snapshot.request) === key,
    );
    // 两种窗口模式均优先查找同一视频；只激活，保留暂停状态和当前位置。
    // 加载失败后再次播放时仍在原窗口重新准备媒体。
    const focusOnly = existing && !existing.snapshot.error;
    const snapshot = {
      opened: true,
      preparing: true,
      request,
      revision: this.snapshot.revision + 1,
    };
    const session = existing ?? ((reuse && this.latest()) || this.createSession(snapshot));
    if (!focusOnly) this.updateSession(session, snapshot);
    let started = false;
    const operation = (async () => {
      await session.ready;
      if (!this.closing) {
        await this.command(session, focusOnly ? { action: "focus" } : { action: "play", request });
        started = !focusOnly;
      }
    })();
    this.operation = operation;
    try {
      await operation;
      return { started };
    } catch (error) {
      if (!focusOnly && !this.closing && this.sessions.has(session))
        this.updateSession(session, {
          ...session.snapshot,
          preparing: false,
          error: playbackError(error),
        });
      throw error;
    } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }
  async close() {
    if (this.closing) return this.closing;
    if (!this.sessions.size) return;
    const closing = (async () => {
      // 同时取消各窗口；一个清理失败也必须让其余窗口完成收尾。
      const results = await Promise.allSettled(
        [...this.sessions].map(async (session) => {
          await session.ready.catch((error: unknown) => {
            if (this.sessions.has(session)) throw error;
          });
          if (this.sessions.has(session)) await this.command(session, { action: "close" });
        }),
      );
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length)
        throw new Error(errors.map((result) => playbackError(result.reason)).join("\n"));
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      this.closing = undefined;
    }
  }
  async shutdown() {
    this.stopped = true;
    await this.close();
  }
}
