import Hls from "hls.js";
import type { LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";
import type { NativeMediaFetch } from "./PlaybackService";

export function createHlsLoader(nativeFetch: NativeMediaFetch, forceNative: boolean) {
  const nativeOrigins = new Set<string>();
  return class extends Hls.DefaultConfig.loader {
    private controller = new AbortController();
    private fallingBack = false;
    private nativeCallbacks?: LoaderCallbacks<LoaderContext>;
    private timer?: ReturnType<typeof setTimeout>;
    override load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ) {
      const fallback = () => {
        if (this.controller.signal.aborted || this.fallingBack) return;
        this.fallingBack = true;
        this.nativeCallbacks = callbacks;
        this.context = context;
        this.stats.loading.start = performance.now();
        this.timer = setTimeout(() => {
          this.controller.abort();
          this.stats.aborted = true;
          this.nativeCallbacks = undefined;
          callbacks.onTimeout(this.stats, context, null);
        }, config.timeout);
        const range =
          context.rangeEnd && context.rangeEnd > 0
            ? { start: context.rangeStart ?? 0, end: context.rangeEnd }
            : undefined;
        void nativeFetch(context.url, this.controller.signal, range)
          .then((response) => {
            if (this.controller.signal.aborted) return;
            clearTimeout(this.timer);
            nativeOrigins.add(new URL(context.url).origin);
            const now = performance.now();
            this.stats.loading.first = this.stats.loading.start;
            this.stats.loading.end = now;
            this.stats.loaded = this.stats.total = response.data.byteLength;
            this.stats.bwEstimate =
              (this.stats.total * 8000) / Math.max(1, now - this.stats.loading.start);
            this.stats.aborted = false;
            const data =
              context.responseType === "arraybuffer"
                ? response.data
                : new TextDecoder().decode(response.data);
            // hls.js 将分片交给解封装器依赖 onProgress；只有 onSuccess 会一直停在首帧前。
            callbacks.onProgress?.(this.stats, context, data, null);
            if (this.controller.signal.aborted) return;
            this.nativeCallbacks = undefined;
            callbacks.onSuccess(
              {
                url: response.url,
                data,
                code: 200,
              },
              this.stats,
              context,
              null,
            );
          })
          .catch(() => {
            clearTimeout(this.timer);
            this.nativeCallbacks = undefined;
            if (!this.controller.signal.aborted)
              callbacks.onError(
                { code: 0, text: "视频源请求失败，请检查网络、链接有效期及来源页面。" },
                context,
                null,
                this.stats,
              );
          });
      };
      const canUseNative = /^https?:\/\//i.test(context.url);
      if (canUseNative && (forceNative || nativeOrigins.has(new URL(context.url).origin)))
        fallback();
      else
        super.load(context, config, {
          ...callbacks,
          onError(error, ...args) {
            if (canUseNative && (error.code === 0 || error.code === 403)) fallback();
            else callbacks.onError(error, ...args);
          },
        });
    }
    override abort() {
      this.controller.abort();
      clearTimeout(this.timer);
      if (this.fallingBack) {
        this.stats.aborted = true;
        const callbacks = this.nativeCallbacks;
        this.nativeCallbacks = undefined;
        if (this.context) callbacks?.onAbort?.(this.stats, this.context, null);
      } else super.abort();
    }
    override destroy() {
      this.controller.abort();
      clearTimeout(this.timer);
      this.nativeCallbacks = undefined;
      super.destroy();
    }
  };
}
