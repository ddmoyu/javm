import { window as nativeWindow } from "@neutralinojs/lib";
import {
  fitPlayerPosition,
  PlayerPreferences,
  playerPosition,
  storedPlayerPreferences,
} from "../../services/playback/PlayerPreferences";
import type { PlayerPosition } from "../../services/playback/PlayerPreferences";
import { PlayerPreferencesClient } from "../../services/playback/preferencesChannel";
import { playerWindowId } from "../../services/playback/windowChannel";
import { playbackError } from "../../services/playback/PlaybackService";
import { logEvent } from "../../services/logging/events";
import type { WindowDisplay } from "../../contracts/window";
import type { Runtime } from "./bootstrap";
import { nativeSettingsStorage } from "./settingsStorage";
import { NativeLibraryPort } from "./library";

let preferences: PlayerPreferences | undefined;
export function createPlayerPreferences(runtime: Runtime) {
  if (!preferences) {
    const id = runtime === "desktop" ? playerWindowId() : undefined;
    if (id) {
      const client = new PlayerPreferencesClient(id);
      window.addEventListener("pagehide", () => client.close(), { once: true });
      preferences = new PlayerPreferences(client);
    } else {
      preferences = storedPlayerPreferences(
        runtime === "desktop"
          ? nativeSettingsStorage("javm-player-preferences-v1")
          : { read: async () => null, write: async () => {} },
      );
    }
  }
  return preferences;
}

/** 主窗口在创建子宿主前恢复坐标；不改写官方主窗口状态文件。 */
export async function readPlayerWindowPosition() {
  try {
    const { position } = await createPlayerPreferences("desktop").read();
    if (!position) return undefined;
    if (window.NL_OS !== "Windows") return position;
    const displays = await new NativeLibraryPort().request<WindowDisplay[]>("window.displays");
    return fitPlayerPosition(position, displays);
  } catch (error) {
    logEvent("warn", "playback", "position_restore_failed", playbackError(error));
    return undefined;
  }
}

/** 一次读取在途、一次补采；只保存普通窗口位置，最小化与全屏坐标不能污染记录。 */
export function trackPlayerWindowPosition(
  settings: PlayerPreferences,
  report: (message: string) => void,
) {
  let previous: PlayerPosition | undefined;
  const ready = nativeWindow
    .getPosition()
    .then((value) => {
      previous = playerPosition(value);
    })
    .catch(() => {});
  let pending = false;
  let saving: Promise<void> | undefined;
  const save = () => {
    pending = true;
    return (saving ??= (async () => {
      try {
        await ready;
        while (pending) {
          pending = false;
          const [maximized, minimized, fullScreen, position] = await Promise.all([
            nativeWindow.isMaximized(),
            nativeWindow.isMinimized(),
            nativeWindow.isFullScreen(),
            nativeWindow.getPosition(),
          ]);
          if (maximized || minimized || fullScreen) continue;
          const next = playerPosition(position);
          if (next.x === previous?.x && next.y === previous?.y) continue;
          await settings.update({ position: next });
          previous = next;
        }
      } finally {
        saving = undefined;
      }
    })());
  };
  const blur = () => {
    void save().catch(() => report("播放器窗口位置保存失败，请重试。"));
  };
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", () => window.removeEventListener("blur", blur), {
    once: true,
  });
  return save;
}
