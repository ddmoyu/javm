import type { PlaybackBookmark, PlaybackHistoryStore } from "./PlaybackHistory";
import { playerChannelName } from "./windowChannel";
import { playbackError } from "./PlaybackService";

type HistoryRequest =
  | { id: string; action: "read"; key: string }
  | { id: string; action: "write"; bookmark: PlaybackBookmark };
interface HistoryReply {
  id: string;
  value?: unknown;
  error?: string;
}
const channelName = (id: string) => `${playerChannelName(id)}:history`;

/** 子窗口不启动数据库扩展，只向所属主窗口请求一行进度。 */
export class PlayerHistoryStore implements PlaybackHistoryStore {
  private channel: BroadcastChannel;
  private stopped = false;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(id: string) {
    this.channel = new BroadcastChannel(channelName(id));
    this.channel.onmessage = ({ data }: MessageEvent<HistoryReply>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.value);
    };
  }
  private request(request: HistoryRequest) {
    if (this.stopped) return Promise.reject(new Error("播放进度通道已关闭。"));
    if (this.pending.size >= 2) return Promise.reject(new Error("播放进度正在保存，请稍后重试。"));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error("播放进度请求超时，请检查主窗口是否仍在运行。"));
      }, 25000);
      this.pending.set(request.id, { resolve, reject, timer });
      this.channel.postMessage(request);
    });
  }
  read(key: string) {
    return this.request({ id: crypto.randomUUID(), action: "read", key });
  }
  async write(bookmark: PlaybackBookmark) {
    await this.request({ id: crypto.randomUUID(), action: "write", bookmark });
  }
  close() {
    this.stopped = true;
    this.channel.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("播放进度通道已关闭。"));
    }
    this.pending.clear();
  }
}

/** 随播放器会话创建和销毁；每个窗口最多两个请求，不积累无界队列。 */
export function servePlaybackHistory(id: string, store: PlaybackHistoryStore) {
  const channel = new BroadcastChannel(channelName(id));
  let active = 0;
  let closed = false;
  const reply = (message: HistoryReply) => {
    if (!closed) channel.postMessage(message);
  };
  channel.onmessage = ({ data }: MessageEvent<HistoryRequest>) => {
    if (!data || typeof data.id !== "string" || data.id.length > 64) return;
    if (active >= 2) {
      reply({ id: data.id, error: "播放进度请求过多，请稍后重试。" });
      return;
    }
    active++;
    void (async () => {
      if (data.action === "read") return store.read(data.key);
      if (data.action === "write") return store.write(data.bookmark);
      throw new Error("无效的播放进度操作。");
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
