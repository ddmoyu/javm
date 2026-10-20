import type { UsageEvent } from "./contract";

let recorder: ((event: UsageEvent) => void) | undefined;
export function setUsageRecorder(value?: (event: UsageEvent) => void) {
  recorder = value;
}
/** 只接受计数类型，不能携带标题、链接、路径或搜索内容。 */
export function recordUsage(event: UsageEvent) {
  try {
    recorder?.(event);
  } catch {
    // 统计失败不能打断用户操作。
  }
}
