import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Loader, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { I18nProvider } from "@videojs/react/i18n";
import workerUrl from "hls.js/dist/hls.worker.js?url";
import "@videojs/react/video/skin.css";
import "./player.css";
import type {
  PreparedPlayback,
  PlaybackController,
  PlaybackSnapshot,
} from "../../services/playback/PlaybackService";
import { playbackError } from "../../services/playback/PlaybackService";
import { createHlsLoader } from "../../services/playback/hlsLoader";
import { bindPlaybackProgress } from "../../services/playback/PlaybackHistory";
import { Icon } from "../../components/icons";
import { window as nativeWindow } from "@neutralinojs/lib";
import { startPlayerDrag } from "../../platform/neutralino/playerFrame";
import { bindToolbarVisibility } from "./toolbarVisibility";
import { logEvent } from "../../services/logging/events";
import {
  getWindowState,
  refreshWindowState,
  subscribeWindowState,
  toggleWindowAlwaysOnTop,
} from "../../platform/neutralino/windowFrame";

function Media({ media }: { media: PreparedPlayback }) {
  const [error, setError] = useState("");
  const [progressError, setProgressError] = useState("");
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const attemptedAutoplay = useRef(false);
  const cleanup = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 每次会话仅创建一次 Loader 类型，避免普通 React 重渲染重建 HLS 引擎。
  const [hlsConfig] = useState(() => ({
    enableWebVTT: false,
    enableIMSC1: false,
    enableCEA708Captions: false,
    enableWorker: true,
    workerPath: workerUrl,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
    ...(media.nativeFetch
      ? { loader: createHlsLoader(media.nativeFetch, !!media.request.referer) }
      : {}),
  }));
  useLayoutEffect(() => {
    if (video.current && media.progress)
      return bindPlaybackProgress(video.current, media.progress, setProgressError);
  }, [media]);
  useEffect(() => {
    clearTimeout(cleanup.current);
    const element = video.current;
    // StrictMode 的模拟卸载会立即再次 setup；真正卸载才清空媒体请求。
    return () => {
      cleanup.current = setTimeout(() => {
        element?.pause();
        element?.removeAttribute("src");
        element?.load();
      }, 0);
    };
  }, []);
  const start = () => {
    if (!video.current) return;
    void video.current
      .play()
      .then(() => setAutoplayBlocked(false))
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "NotAllowedError")
          setAutoplayBlocked(true);
      });
  };
  const props = {
    ref: video,
    autoPlay: true,
    playsInline: true,
    preload: "auto" as const,
    onCanPlay: () => {
      if (!attemptedAutoplay.current) {
        attemptedAutoplay.current = true;
        start();
      }
    },
    onPlaying: () => {
      setError("");
      setAutoplayBlocked(false);
    },
    onError: () => {
      const code = video.current?.error?.code;
      const message =
        code === 3 || code === 4
          ? "当前环境无法解码此视频，或视频源格式无效。可在播放设置中选择外部播放器后重新播放。"
          : "视频加载失败，请检查文件、网络、链接有效期及访问权限后重试。";
      setError(message);
      if (code !== 1)
        logEvent("error", "playback", "media_failed", message, { mediaErrorCode: code ?? 0 });
    },
  };
  return (
    <>
      <div className="playback-surface">
        <I18nProvider locale="zh-CN">
          <VideoPlayer title={media.request.title}>
            <VideoSkin className="javm-video-skin">
              {media.format === "hls" ? (
                <HlsJsVideo
                  {...props}
                  source={{
                    src: media.url,
                    type: "application/vnd.apple.mpegurl",
                    preferPlayback: "mse",
                    engine: { hlsJs: hlsConfig },
                  }}
                />
              ) : (
                <Video {...props} src={media.url} />
              )}
            </VideoSkin>
          </VideoPlayer>
        </I18nProvider>
      </div>
      {error && (
        <Alert color="red" className="playback-feedback" role="alert">
          {error}
        </Alert>
      )}
      {progressError && (
        <Alert color="yellow" className="playback-feedback" role="alert">
          {progressError}
        </Alert>
      )}
      {autoplayBlocked && (
        <Group className="playback-feedback" justify="space-between">
          <Text size="sm">请点击播放以开始视频。</Text>
          <Button size="xs" onClick={start}>
            播放
          </Button>
        </Group>
      )}
    </>
  );
}

export default function PlaybackWindow({
  service,
  snapshot,
  notice,
  native = false,
  onClose,
}: {
  service: PlaybackController;
  snapshot: PlaybackSnapshot;
  notice: (message: string) => void;
  native?: boolean;
  onClose?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { maximized, alwaysOnTop } = useSyncExternalStore(subscribeWindowState, getWindowState);
  const isExpanded = native ? maximized : expanded;
  const [position, setPosition] = useState({ x: 24, y: 70 });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const nativeDrag = useRef<ReturnType<typeof startPlayerDrag> | undefined>(undefined);
  const root = useRef<HTMLDialogElement>(null);
  const toolbar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (root.current && toolbar.current)
      return bindToolbarVisibility(root.current, toolbar.current);
  }, []);
  useEffect(() => {
    const origin = document.activeElement;
    root.current?.focus();
    return () => {
      if (origin instanceof HTMLElement && origin.isConnected)
        origin.focus({ preventScroll: true });
    };
  }, []);
  const report = (promise: Promise<void>) => {
    void promise.catch((error: unknown) => notice(playbackError(error)));
  };
  const toggleMaximize = async () => {
    if (!native) {
      setExpanded((value) => !value);
      return;
    }
    await ((await nativeWindow.isMaximized())
      ? nativeWindow.unmaximize()
      : nativeWindow.maximize());
    await refreshWindowState();
  };
  return (
    <Paper
      component="dialog"
      open
      ref={root}
      tabIndex={-1}
      aria-modal={false}
      aria-label="视频播放器"
      withBorder={!native}
      shadow={native ? undefined : "xl"}
      className="playback-window"
      data-expanded={expanded || undefined}
      data-native={native || undefined}
      data-revision={snapshot.revision}
      style={
        native || expanded
          ? undefined
          : {
              left: `min(${position.x}px, max(0px, 100vw - 440px))`,
              top: `min(${position.y}px, max(34px, 100vh - 268px))`,
              maxWidth: `calc(100vw - min(${position.x}px, max(0px, 100vw - 440px)) - 8px)`,
              maxHeight: `calc(100vh - min(${position.y}px, max(34px, 100vh - 268px)) - 8px)`,
            }
      }
    >
      <header className="playback-titlebar" ref={toolbar} aria-label="播放窗口工具栏">
        <UnstyledButton
          className="playback-drag"
          aria-label={`移动播放器：${snapshot.request?.title ?? "视频"}`}
          onDoubleClick={() => report(toggleMaximize())}
          onPointerDown={(event) => {
            if (native) {
              if (event.button === 0) {
                nativeDrag.current = startPlayerDrag(event, maximized, () =>
                  notice("窗口拖动失败，请重试。"),
                );
                event.currentTarget.setPointerCapture(event.pointerId);
              }
              return;
            }
            if (expanded || event.button !== 0) return;
            const box = root.current!.getBoundingClientRect();
            drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (native) {
              nativeDrag.current?.move(event.screenX, event.screenY);
              return;
            }
            if (!drag.current) return;
            setPosition({
              x: Math.max(
                0,
                Math.min(
                  window.innerWidth - 160,
                  drag.current.left + event.clientX - drag.current.x,
                ),
              ),
              y: Math.max(
                34,
                Math.min(
                  window.innerHeight - 80,
                  drag.current.top + event.clientY - drag.current.y,
                ),
              ),
            });
          }}
          onPointerUp={() => {
            nativeDrag.current?.finish();
            nativeDrag.current = undefined;
            drag.current = null;
          }}
          onPointerCancel={() => {
            nativeDrag.current?.cancel();
            nativeDrag.current = undefined;
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (native) return;
            const step = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -20],
              ArrowDown: [0, 20],
            }[event.key];
            if (!expanded && step) {
              event.preventDefault();
              setPosition((old) => ({
                x: Math.max(0, Math.min(innerWidth - 160, old.x + step[0]!)),
                y: Math.max(34, Math.min(innerHeight - 80, old.y + step[1]!)),
              }));
            }
          }}
        >
          <Icon name="play" size={15} />
          <Text truncate size="sm" fw={600}>
            {snapshot.request?.title ?? "视频播放器"}
          </Text>
        </UnstyledButton>
        <Group gap={0} wrap="nowrap">
          {native && (
            <UnstyledButton
              className="window-button"
              aria-label={alwaysOnTop ? "取消置顶" : "置顶播放器"}
              aria-pressed={alwaysOnTop}
              data-active={alwaysOnTop || undefined}
              onClick={() => report(toggleWindowAlwaysOnTop())}
            >
              <Icon name="pin" size={14} filled={alwaysOnTop} />
            </UnstyledButton>
          )}
          {native && (
            <UnstyledButton
              className="window-button"
              aria-label="最小化播放器"
              onClick={() => report(nativeWindow.minimize())}
            >
              <Icon name="minimize" size={14} />
            </UnstyledButton>
          )}
          <UnstyledButton
            className="window-button"
            aria-label={isExpanded ? "还原播放器" : "最大化播放器"}
            onClick={() => report(toggleMaximize())}
          >
            <Icon name={isExpanded ? "restore" : "maximize"} size={14} />
          </UnstyledButton>
          <UnstyledButton
            className="window-button close"
            aria-label="关闭播放器"
            onClick={() => report(onClose ? onClose() : service.close())}
          >
            <Icon name="close" size={16} />
          </UnstyledButton>
        </Group>
      </header>
      {snapshot.media ? (
        <Media key={snapshot.revision} media={snapshot.media} />
      ) : (
        <Stack
          className="playback-placeholder"
          align="center"
          justify="center"
          role={snapshot.error ? "alert" : "status"}
        >
          {snapshot.preparing ? (
            <>
              <Loader size="sm" />
              <Text size="sm">正在加载视频…</Text>
            </>
          ) : (
            <>
              <Icon name="warning" size={28} />
              <Text size="sm" ta="center">
                {snapshot.error ?? "视频已停止"}
              </Text>
            </>
          )}
        </Stack>
      )}
    </Paper>
  );
}
