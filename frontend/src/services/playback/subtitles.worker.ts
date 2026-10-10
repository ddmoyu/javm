import { subtitleVtt } from "./subtitles";
self.onmessage = ({ data }: MessageEvent<{ bytes: ArrayBuffer; name: string }>) => {
  try {
    self.postMessage({ text: subtitleVtt(data.bytes, data.name) });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : "字幕转换失败" });
  }
};
