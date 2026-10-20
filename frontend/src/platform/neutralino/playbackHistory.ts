import { PlaybackHistory } from "../../services/playback/PlaybackHistory";
import { DatabasePlaybackHistoryStore } from "../../services/playback/DatabasePlaybackHistoryStore";
import { PlayerHistoryStore } from "../../services/playback/historyChannel";
import { playerWindowId } from "../../services/playback/windowChannel";
import { NativeLibraryPort } from "./library";
import { playbackStorage } from "./playbackSettings";

let databaseStore: DatabasePlaybackHistoryStore | undefined;
export function createPlaybackHistoryStore() {
  databaseStore ??= new DatabasePlaybackHistoryStore(
    new NativeLibraryPort(),
    playbackStorage("javm-playback-history-v1"),
  );
  return databaseStore;
}

let history: PlaybackHistory | undefined;
export function createPlaybackHistory() {
  if (!history) {
    const id = playerWindowId();
    if (id) {
      const store = new PlayerHistoryStore(id);
      window.addEventListener("pagehide", () => store.close(), { once: true });
      history = new PlaybackHistory(store);
    } else history = new PlaybackHistory(createPlaybackHistoryStore());
  }
  return history;
}
