import { ResolutionError } from "./shared";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
/** Only connects to the endpoint read from this task's isolated browser profile. */
export class CdpConnection {
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(reason: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: CdpEvent) => void>();
  private closed = false;
  private constructor(
    private readonly socket: WebSocket,
    private readonly signal: AbortSignal,
  ) {
    socket.addEventListener("message", this.message);
    socket.addEventListener("close", this.abort);
    socket.addEventListener("error", this.abort);
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.close();
  }
  static async connect(url: string, signal: AbortSignal) {
    if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url))
      throw new ResolutionError("unavailable");
    signal.throwIfAborted();
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        signal.removeEventListener("abort", failed);
        if (error) {
          socket.close();
          reject(error);
        } else resolve();
      };
      const opened = () => finish();
      const failed = () =>
        finish(new ResolutionError(signal.aborted ? "cancelled" : "unavailable"));
      const timer = setTimeout(failed, 3000);
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
      signal.addEventListener("abort", failed, { once: true });
    });
    return new CdpConnection(socket, signal);
  }
  private message = (event: MessageEvent) => {
    if (typeof event.data !== "string" || event.data.length > 1024 * 1024) {
      this.close();
      return;
    }
    try {
      const value = JSON.parse(event.data) as CdpEvent & {
        id?: number;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      if (value.id) {
        const task = this.pending.get(value.id);
        if (!task) return;
        this.pending.delete(value.id);
        clearTimeout(task.timer);
        if (value.error) task.reject(new ResolutionError("unavailable"));
        else task.resolve(value.result ?? {});
      } else if (typeof value.method === "string") {
        for (const listener of this.listeners) listener(value);
      }
    } catch {
      this.close();
    }
  };
  private abort = () => this.close();
  on(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed || this.signal.aborted)
      return Promise.reject(new ResolutionError(this.signal.aborted ? "cancelled" : "unavailable"));
    if (this.pending.size >= 64) return Promise.reject(new ResolutionError("limit_exceeded"));
    const id = ++this.serial;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ResolutionError("timeout"));
      }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ResolutionError("unavailable"));
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.socket.removeEventListener("message", this.message);
    this.socket.removeEventListener("close", this.abort);
    this.socket.removeEventListener("error", this.abort);
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new ResolutionError(this.signal.aborted ? "cancelled" : "unavailable"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.socket.close();
  }
}
