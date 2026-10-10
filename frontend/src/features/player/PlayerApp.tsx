import { useSyncExternalStore } from "react";
import { Alert } from "@mantine/core";
import PlaybackWindow from "./PlaybackWindow";
import type { Runtime } from "../../platform/neutralino/bootstrap";
import { createPlaybackService } from "../../platform/neutralino/playback";
import { connectPlayerWindow } from "../../platform/neutralino/playerWindow";
import { logEvent } from "../../services/logging/events";

export function createPlayerView(id: string, runtime: Runtime) {
  document.documentElement.dataset.windowKind = "player";
  const service = createPlaybackService(runtime);
  let message = "";
  const listeners = new Set<() => void>();
  const notice = (text: string) => {
    if (text) logEvent("warn", "playback", "notice", text);
    message = text;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getMessage = () => message;
  const close = connectPlayerWindow(id, service, notice);
  function PlayerView() {
    const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
    const error = useSyncExternalStore(subscribe, getMessage);
    return (
      <>
        <PlaybackWindow
          service={service}
          snapshot={snapshot}
          notice={notice}
          native
          onClose={close}
        />
        {error && (
          <Alert
            className="player-window-notice"
            color="red"
            withCloseButton
            onClose={() => notice("")}
            role="alert"
          >
            {error}
          </Alert>
        )}
      </>
    );
  }
  return <PlayerView />;
}
