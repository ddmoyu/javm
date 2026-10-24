import type { PlayerPreferencesPort, PlayerPreferencesValue } from "./PlayerPreferences";
import { playerChannelName } from "./windowChannel";
import { playbackError } from "./PlaybackService";

interface Request {
  id: string;
  action: "read" | "update";
  patch?: Partial<PlayerPreferencesValue>;
}
interface Reply {
  id: string;
  value?: PlayerPreferencesValue;
  error?: string;
}
const channelName = (id: string) => `${playerChannelName(id)}:preferences`;

export class PlayerPreferencesClient implements PlayerPreferencesPort {
  private channel: BroadcastChannel;
  private stopped = false;
  private pending = new Map<
    string,
    {
      resolve(value: PlayerPreferencesValue): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(id: string) {
    this.channel = new BroadcastChannel(channelName(id));
    this.channel.onmessage = ({ data }: MessageEvent<Reply>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);
      if (data.error || !data.value)
        pending.reject(new Error(data.error || "播放器设置响应无效。"));
      else pending.resolve(data.value);
    };
  }
  private request(action: Request["action"], patch?: Partial<PlayerPreferencesValue>) {
    if (this.stopped) return Promise.reject(new Error("播放器设置通道已关闭。"));
    if (this.pending.size >= 4)
      return Promise.reject(new Error("播放器设置正在保存，请稍后重试。"));
    const id = crypto.randomUUID();
    return new Promise<PlayerPreferencesValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("播放器设置请求超时，请检查主窗口是否仍在运行。"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.channel.postMessage({ id, action, patch } satisfies Request);
    });
  }
  read() {
    return this.request("read");
  }
  update(patch: Partial<PlayerPreferencesValue>) {
    return this.request("update", patch);
  }
  close() {
    this.stopped = true;
    this.channel.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("播放器设置通道已关闭。"));
    }
    this.pending.clear();
  }
}

export function servePlayerPreferences(id: string, preferences: PlayerPreferencesPort) {
  const channel = new BroadcastChannel(channelName(id));
  let active = 0;
  let closed = false;
  const reply = (message: Reply) => {
    if (!closed) channel.postMessage(message);
  };
  channel.onmessage = ({ data }: MessageEvent<Request>) => {
    if (!data || typeof data.id !== "string" || data.id.length > 64) return;
    if (active >= 4) {
      reply({ id: data.id, error: "播放器设置请求过多，请稍后重试。" });
      return;
    }
    active++;
    void (async () => {
      if (data.action === "read") return preferences.read();
      if (data.action === "update" && data.patch) return preferences.update(data.patch);
      throw new Error("无效的播放器设置操作。");
    })()
      .then(
        (value) => reply({ id: data.id, value }),
        (error: unknown) => reply({ id: data.id, error: playbackError(error) }),
      )
      .finally(() => {
        active--;
      });
  };
  return () => {
    closed = true;
    channel.close();
  };
}
