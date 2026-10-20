import { HlsPlanError } from "./hls";
import { createPlannerCore } from "./hlsPlanner";
import type { HlsPlannerTasks } from "./hlsPlanner";

// 此模块只在 Worker 中加载；播放列表文本始终作为数据处理。
const core = createPlannerCore();
globalThis.onmessage = ({
  data,
}: MessageEvent<{ id: number; operation: keyof HlsPlannerTasks; input: never }>) => {
  try {
    globalThis.postMessage({ id: data.id, value: core.handle(data.operation, data.input) });
  } catch (error) {
    globalThis.postMessage({
      id: data.id,
      error: {
        message: error instanceof Error ? error.message : "HLS 播放列表解析失败。",
        plan: error instanceof HlsPlanError,
      },
    });
  }
};
