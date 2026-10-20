import { events, extensions } from "@neutralinojs/lib";

class PrivacyPort {
  private listening?: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.pending.size >= 8) throw new Error("隐私服务忙，请稍后重试。");
    this.listening ??= events
      .on(
        "javm.database.response",
        (
          event: CustomEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>,
        ) => {
          const value = event.detail;
          const pending = this.pending.get(value.requestId);
          if (!pending) return;
          this.pending.delete(value.requestId);
          clearTimeout(pending.timer);
          if (value.ok) pending.resolve(value.result);
          else pending.reject(new Error(value.error || "隐私服务操作失败。"));
        },
      )
      .then(() => {});
    await this.listening;
    if (this.pending.size >= 8) throw new Error("隐私服务忙，请稍后重试。");
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          if (method === "privacy.pick")
            void this.request("privacy.cancelPick", { requestId }).catch(() => {});
          reject(new Error("隐私服务未响应，请重试。"));
        },
        method === "privacy.pick" ? 300000 : 15000,
      );
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      void extensions
        .dispatch("net.ddmoyu.javm.database", "javm.database.request", {
          requestId,
          protocol: 1,
          method,
          params,
        })
        .catch(() => {
          if (!this.pending.delete(requestId)) return;
          clearTimeout(timer);
          reject(new Error("无法连接隐私服务，请检查原生扩展。"));
        });
    });
  }
}
export const privacyNative = new PrivacyPort();
