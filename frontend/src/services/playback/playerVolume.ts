import type { PlayerPreferences } from "./PlayerPreferences";

/** 恢复完成后才允许自动播放；只记录音量，不记录隐私保护施加的临时静音。 */
export function bindPlayerVolume(
  media: HTMLMediaElement,
  preferences: PlayerPreferences,
  report: (message: string) => void,
) {
  let disposed = false;
  let loaded = false;
  let committed = media.volume;
  let latest = committed;
  let revision = 0;
  const ready = preferences.read().then(
    (value) => {
      if (disposed) return;
      committed = latest = value.volume;
      media.volume = value.volume;
      loaded = true;
    },
    () => {
      if (!disposed) report("无法读取播放器音量，暂用默认音量；原设置已保留。");
    },
  );
  const changed = () => {
    if (!loaded || disposed || media.volume === latest) return;
    latest = media.volume;
    const change = ++revision;
    void preferences.update({ volume: latest }).then(
      (value) => {
        committed = value.volume;
        if (!disposed && change === revision) report("");
      },
      async () => {
        if (disposed || change !== revision) return;
        // 一批合并修改可能已保存前一笔，再在最后一笔失败；回读实际提交值。
        const value = await preferences.read().catch(() => ({ volume: committed }));
        if (disposed || change !== revision) return;
        committed = latest = value.volume;
        media.volume = value.volume;
        report("播放器音量保存失败，已恢复上次音量，请重试。");
      },
    );
  };
  media.addEventListener("volumechange", changed);
  return {
    ready,
    dispose: () => {
      disposed = true;
      media.removeEventListener("volumechange", changed);
    },
  };
}
