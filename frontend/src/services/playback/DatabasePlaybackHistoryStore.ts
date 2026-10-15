import { readLegacyPlaybackHistory, readPlaybackBookmark } from "./PlaybackHistory";
import type { PlaybackBookmark, PlaybackHistoryStore } from "./PlaybackHistory";

interface DatabasePort {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** 旧记录只做幂等导入；数据库已有的位置（包括已看完的零位置）优先。 */
export class DatabasePlaybackHistoryStore implements PlaybackHistoryStore {
  private initialized?: Promise<void>;
  constructor(
    private database: DatabasePort,
    private legacy: { read(): Promise<unknown> },
  ) {}
  private initialize() {
    this.initialized ??= (async () => {
      const records = readLegacyPlaybackHistory(await this.legacy.read());
      if (records.length) await this.database.request("library.playback.import", { records });
    })().catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }
  async read(key: string) {
    await this.initialize();
    return this.database.request("library.playback.get", { key });
  }
  async write(bookmark: PlaybackBookmark) {
    const record = readPlaybackBookmark(bookmark);
    await this.initialize();
    await this.database.request("library.playback.save", { records: [record] });
  }
}
