import { publicMessage } from "../publicMessage";

export interface Store<T> {
  read(): Promise<unknown>;
  write(value: T): Promise<void>;
  migrate?(create: () => T): Promise<unknown>;
}
/** 迁移前重新检查目标；已有记录（包括非法记录）交给调用方校验，不能覆盖。 */
export async function migrateSettings<T>(store: Store<T>, create: () => T): Promise<unknown> {
  if (store.migrate) return store.migrate(create);
  const current = await store.read();
  if (current !== null) return current;
  const value = create();
  await store.write(value);
  return value;
}
export class Observable<T> {
  private listeners = new Set<() => void>();
  constructor(protected snapshot: T) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected publish(patch: Partial<T>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
export class Settings<T> extends Observable<{
  value: T;
  ready: boolean;
  available: boolean;
  error: string;
  saving: boolean;
}> {
  private loading?: Promise<void>;
  constructor(
    private store: Store<T>,
    initial: T,
    readonly validate: (value: unknown) => T,
    available: boolean,
  ) {
    super({ value: initial, ready: false, available, error: "", saving: false });
  }
  initialize() {
    return (this.loading ??= (async () => {
      try {
        const data = this.snapshot.available ? await this.store.read() : null;
        if (data !== null) this.publish({ value: this.validate(data) });
        this.publish({ ready: true });
      } catch {
        this.publish({ ready: true, error: "无法读取服务配置，请检查数据目录或重新保存。" });
      }
    })());
  }
  async save(value: T) {
    if (!this.snapshot.available) throw new Error("请在 Windows 桌面端保存配置。");
    if (this.snapshot.saving) throw new Error("正在保存，请稍候。");
    const validated = this.validate(value);
    this.publish({ saving: true });
    try {
      await this.initialize();
      await this.store.write(validated);
      this.publish({ value: validated, error: "" });
    } finally {
      this.publish({ saving: false });
    }
  }
  async require() {
    await this.initialize();
    if (!this.snapshot.available) throw new Error("请在 Windows 桌面应用中使用此服务。");
    if (this.snapshot.error) throw new Error(this.snapshot.error);
    return this.snapshot.value;
  }
}
export interface JsonRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  metadataDiagnostics?: boolean;
}
export type JsonHttp = (request: JsonRequest, signal: AbortSignal) => Promise<unknown>;
export class JsonHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly diagnostics?: unknown,
  ) {
    super(message);
    this.name = "JsonHttpError";
  }
}
export function serviceError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "已取消";
  return error instanceof Error ? publicMessage(error.message) : "服务操作失败，请重试。";
}
export function serviceUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入有效服务地址。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("服务地址需包含 http:// 或 https://。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("服务地址仅支持 HTTP/HTTPS，不能包含凭据、查询参数或片段。");
  return url.href.replace(/\/+$/, "");
}
export function text(value: unknown, maximum = 4096) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 && !["\n", "\r", "\t"].includes(char))
  )
    throw new Error("服务返回了无效或过长的文本。");
  return value.trim();
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("服务响应格式不正确。");
  return value as Record<string, unknown>;
}
export function list(value: unknown, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error("服务响应列表无效或超过限制。");
  return [...new Set(value.map((item) => text(item, 200)).filter(Boolean))];
}
