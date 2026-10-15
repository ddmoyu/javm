import { app, events, window as nativeWindow } from "@neutralinojs/lib";
import { t } from "../../i18n/core";
import { PlayerWindowController } from "../../services/playback/PlayerWindowController";
import { playbackError } from "../../services/playback/PlaybackService";
import type { PlaybackController } from "../../services/playback/PlaybackService";
import type { PlaybackWindowMode } from "../../services/playback/PlaybackSettingsService";
import { playerChannelName } from "../../services/playback/windowChannel";
import type { PlayerWindowMessage } from "../../services/playback/windowChannel";
import { createPlaybackHistoryStore } from "./playbackHistory";
import { captureUnhandledErrors, setLogSink } from "../../services/logging/events";

export function createPlayerWindowController(windowMode: () => PlaybackWindowMode) {
  const controller = new PlayerWindowController(
    async (id) => {
      // 使用主页面 origin，以同源 BroadcastChannel 通信；每个窗口仍连接自己的官方原生 API。
      const url = new URL(location.pathname, location.origin);
      url.searchParams.set("javmPlayer", id);
      const args = (window as unknown as { NL_ARGS: string[] }).NL_ARGS;
      const resourceMode = args.find((arg) => /^--res-mode=(directory|bundle|embedded)$/.test(arg));
      await nativeWindow.create(url.href, {
        title: t("JAVM 播放器"),
        width: 960,
        height: 600,
        minWidth: 440,
        minHeight: 300,
        center: true,
        borderless: true,
        maximizable: true,
        resizable: true,
        exitProcessOnClose: false,
        injectGlobals: true,
        processArgs: `--enable-extensions=false --export-auth-info=false --port=0 --window-skip-taskbar=false ${resourceMode ?? ""}`,
      });
    },
    windowMode,
    createPlaybackHistoryStore(),
  );
  window.addEventListener("pagehide", () => {
    void controller.close().catch(() => {});
  });
  return controller;
}

/** 在 React 外初始化一次，不为子窗口注册主程序托盘或后台业务。 */
export function connectPlayerWindow(
  id: string,
  service: PlaybackController,
  notice: (message: string) => void,
) {
  const channel = new BroadcastChannel(playerChannelName(id));
  const send = (message: PlayerWindowMessage) => channel.postMessage(message);
  let rateStart = performance.now();
  let rateCount = 0;
  setLogSink((input) => {
    if (performance.now() - rateStart >= 1000) {
      rateStart = performance.now();
      rateCount = 0;
    }
    if (++rateCount <= 100) send({ type: "log", input });
  });
  const stopCapturing = captureUnhandledErrors();
  let closing: Promise<void> | undefined;
  let lastContact = performance.now();
  let lastTick = lastContact;
  let contacted = false;
  const sync = () => {
    const { opened, preparing, request, error, revision } = service.getSnapshot();
    if (preparing) notice("");
    send({ type: "state", snapshot: { opened, preparing, request, error, revision } });
  };
  const unsubscribe = service.subscribe(sync);
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await service.close();
        send({ type: "closed" });
        // 让同源消息先送达主窗口，再退出独立宿主。
        await new Promise((resolve) => setTimeout(resolve, 100));
        await app.exit();
        clearInterval(lease);
        stopCapturing();
        setLogSink();
        unsubscribe();
        channel.close();
      } catch (error) {
        closing = undefined;
        throw error;
      }
    })();
    return closing;
  };
  channel.onmessage = ({ data }: MessageEvent<PlayerWindowMessage>) => {
    lastContact = performance.now();
    contacted = true;
    if (data.type === "ping") {
      send({ type: "pong" });
      return;
    }
    if (data.type !== "command") return;
    const execute = async () => {
      if (data.command.action === "close") {
        await close();
        return;
      }
      if (closing) throw new Error("播放器正在关闭。");
      if (data.command.action === "play")
        await nativeWindow.setTitle(`${data.command.request.title} · JAVM`);
      if (await nativeWindow.isMinimized()) await nativeWindow.unminimize();
      await nativeWindow.show();
      await nativeWindow.focus();
      // 窗口 API 等待期间可能收到关闭事件，不能随后启动一个新播放会话。
      if (closing) throw new Error("播放器正在关闭。");
      if (data.command.action === "play") {
        const request = data.command.request;
        await service.play(request.source, request);
      }
      send({ type: "result", id: data.id });
    };
    void execute().catch((error: unknown) => {
      const message = playbackError(error);
      notice(message);
      send({ type: "result", id: data.id, error: message });
    });
  };
  void events.on("windowClose", () => {
    void close().catch((error: unknown) => notice(playbackError(error)));
  });
  // 主进程意外离开后自行收尾；宽松租约容忍最小化和系统休眠导致的计时器节流。
  const lease = setInterval(() => {
    const now = performance.now();
    if (now - lastTick > 15000) lastContact = now;
    lastTick = now;
    if (now - lastContact > (contacted ? 120000 : 25000))
      void close().catch((error: unknown) => notice(playbackError(error)));
  }, 5000);
  send({ type: "ready" });
  return close;
}
