import type { ParseTasks } from "./ports";
import { parsePage, parsePlaylist } from "./parsers";
import { failure, ResolutionError } from "./shared";

export type ParseMessage = {
  [K in keyof ParseTasks]: { operation: K; input: ParseTasks[K]["input"] };
}[keyof ParseTasks];

// 此模块只在 Worker 中加载；远端文本始终作为数据处理。
globalThis.onmessage = ({ data }: MessageEvent<ParseMessage>) => {
  try {
    const value =
      data.operation === "page"
        ? parsePage(data.input.body, data.input.url, data.input.provider)
        : parsePlaylist(data.input.body, data.input.url);
    globalThis.postMessage({ value });
  } catch (error) {
    globalThis.postMessage({
      error: failure(
        error instanceof ResolutionError ? error : new ResolutionError("parse_failed", true),
      ),
    });
  }
};
globalThis.postMessage({ ready: true });
