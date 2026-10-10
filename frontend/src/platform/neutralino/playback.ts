import { filesystem, server } from "@neutralinojs/lib";
import type { Runtime } from "./bootstrap";
import { PlaybackService } from "../../services/playback/PlaybackService";
import type {
  PlaybackController,
  PlaybackPort,
  PreparedPlayback,
} from "../../services/playback/PlaybackService";
import {
  canMountMediaDirectory,
  localMediaLocation,
  responseFormat,
} from "../../services/playback/source";
import type { PlaybackOptions } from "../../services/playback/source";
import { NativeMediaTransport } from "./playbackTransport";
import { mediaResourceUrl } from "./playbackResources";
import { createLocalPlaybackStream } from "./playbackStream";
import { createPlayerWindowController } from "./playerWindow";
import { playerWindowId } from "../../services/playback/windowChannel";
import { PreferredPlaybackController } from "../../services/playback/PreferredPlaybackController";
import { createPlaybackSettings, openExternalPlayer } from "./playbackSettings";
import { createPlaybackHistory } from "./playbackHistory";
import { prepareSubtitles } from "./subtitles";

function mediaPort(runtime: Runtime): PlaybackPort {
  return {
    async prepare(request, signal) {
      if (request.kind === "local") {
        if (runtime !== "desktop") throw new Error("本地路径播放需要在 JAVM 桌面应用中使用。");
        const stat = await filesystem.getStats(request.source).catch(() => null);
        if (!stat?.isFile) throw new Error("视频文件不存在或无法读取，请检查路径及磁盘连接。");
        signal.throwIfAborted();
        const { directory, fileName } = localMediaLocation(request.source);
        const prefix = `/javm-playback/${crypto.randomUUID()}`;
        let mounted = canMountMediaDirectory(directory);
        if (!mounted && request.format === "hls")
          throw new Error("本地 HLS 请放在独立文件夹中，避免挂载整个磁盘或共享根目录。");
        if (mounted) await server.mount(prefix, directory);
        const transport = request.format === "hls" ? new NativeMediaTransport() : undefined;
        const resourceUrl = mediaResourceUrl(`${prefix}/${encodeURIComponent(fileName)}`);
        const stream =
          request.format === "hls"
            ? undefined
            : await createLocalPlaybackStream(
                request.source,
                mounted ? resourceUrl : undefined,
                stat.size,
                signal,
              ).catch(async (error: unknown) => {
                if (mounted) await server.unmount(prefix);
                throw error;
              });
        const media: PreparedPlayback = {
          request,
          url: stream?.url ?? resourceUrl,
          format: request.format ?? "video",
          nativeFetch: transport?.fetch,
          dispose: async () => {
            stream?.dispose();
            await transport?.dispose();
            if (mounted) {
              await server.unmount(prefix);
              mounted = false;
            }
          },
        };
        if (signal.aborted) {
          await media.dispose();
          signal.throwIfAborted();
        }
        return media;
      }
      const transport =
        runtime === "desktop"
          ? new NativeMediaTransport(request.referer ?? `${new URL(request.source).origin}/`)
          : undefined;
      let format = request.format;
      try {
        if (!format) {
          try {
            const response = await fetch(request.source, {
              method: "HEAD",
              signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            });
            format = responseFormat(response.headers.get("content-type"));
          } catch {
            /* 无 CORS 的流在桌面上交给原生传输探测。 */
          }
          if (!format && transport) {
            try {
              format = responseFormat(
                (await transport.probe(request.source, signal)).contentType ?? null,
              );
            } catch {
              /* 有些源不接受 HEAD；由后续媒体请求报告真实错误。 */
            }
          }
          if (!format) {
            try {
              const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
              const response = await fetch(request.source, {
                headers: { Range: "bytes=0-511" },
                signal: probeSignal,
              });
              const reader = response.body?.getReader();
              try {
                const first = await reader?.read();
                if (
                  first?.value &&
                  new TextDecoder()
                    .decode(first.value.subarray(0, 512))
                    .trimStart()
                    .startsWith("#EXTM3U")
                )
                  format = "hls";
              } finally {
                await reader?.cancel();
              }
            } catch {
              /* 类型提示可由 format 参数补充，默认交由媒体元素识别。 */
            }
          }
        }
        signal.throwIfAborted();
        return {
          request,
          url: request.source,
          format: format ?? "video",
          nativeFetch: transport?.fetch,
          dispose: async () => {
            await transport?.dispose();
          },
        };
      } catch (error) {
        await transport?.dispose();
        throw error;
      }
    },
  };
}

export function playbackPort(runtime: Runtime): PlaybackPort {
  const port = mediaPort(runtime);
  return {
    ...port,
    async prepare(request, signal) {
      const progress =
        runtime === "desktop" ? await createPlaybackHistory().session(request) : undefined;
      signal.throwIfAborted();
      const media = await port.prepare(request, signal);
      let tracks: Awaited<ReturnType<typeof prepareSubtitles>> | undefined;
      try {
        if (runtime === "desktop" && request.subtitles?.length)
          tracks = await prepareSubtitles(
            request.subtitles,
            AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          );
      } catch (e) {
        await media.dispose();
        throw e;
      }
      return {
        ...media,
        progress,
        subtitles: tracks?.subtitles,
        subtitleWarning: tracks?.warning,
        dispose: async () => {
          try {
            await progress?.flush();
          } finally {
            tracks?.dispose();
            await media.dispose();
          }
        },
      };
    },
  };
}

let service: PlaybackController | undefined;
export function createPlaybackService(runtime: Runtime) {
  service ??=
    runtime === "desktop" && !playerWindowId()
      ? new PreferredPlaybackController(
          createPlayerWindowController(
            () => createPlaybackSettings(runtime).getSnapshot().settings.windowMode,
          ),
          createPlaybackSettings(runtime),
          (request, path, signal) => openExternalPlayer(runtime, request, path, signal),
        )
      : new PlaybackService(playbackPort(runtime));
  return service;
}

/** 业务函数入口：本地绝对路径与网络直链共用，不创建额外的输入界面。 */
export function play(source: string, options?: PlaybackOptions): Promise<void> {
  return createPlaybackService("NL_PORT" in window ? "desktop" : "browser").play(source, options);
}
