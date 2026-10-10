export interface MediaProbe {
  video: boolean;
  audio: boolean;
  videoTracks: number;
  audioTracks: number;
  durationMs: number;
  width: number;
  height: number;
  audioChannels: number;
  audioLanguage: string;
}

export type MediaRequest = (method: string, params: unknown) => Promise<unknown>;

export function createMediaProbe(request: MediaRequest) {
  return async (path: string, signal: AbortSignal): Promise<MediaProbe> => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const active = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    // Dispatch the probe first so even an abort during Extension setup cancels the right job.
    const pending = request("media.probe", { id, path });
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void request("media.cancelProbe", { id }).catch(() => {});
    };
    active.addEventListener("abort", cancel, { once: true });
    try {
      const result = (await pending) as MediaProbe;
      active.throwIfAborted();
      if (
        !result ||
        typeof result.video !== "boolean" ||
        typeof result.audio !== "boolean" ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs < 0 ||
        (!result.video && !result.audio)
      )
        throw new Error("文件中没有可识别的音视频流。");
      return result;
    } catch (error) {
      cancel();
      active.throwIfAborted();
      throw error;
    } finally {
      active.removeEventListener("abort", cancel);
    }
  };
}
