import type { MetadataDiagnostics } from "../metadata/diagnostics";
import type { ReproductionContext } from "../logging/reproduction";

export interface FailureInput {
  module: string;
  title: string;
  message: string;
  taskId?: string;
  url?: string;
  details?: Record<string, string | number | boolean>;
  occurredAt?: string;
  metadata?: MetadataDiagnostics;
  reproduction?: ReproductionContext;
}

let sink: ((failure: FailureInput, open?: boolean) => string | undefined) | undefined;
export function setFailureSink(next?: typeof sink) {
  sink = next;
}
export function reportFailure(failure: FailureInput, open = false) {
  try {
    return sink?.(failure, open);
  } catch {
    // 反馈失败不能改变原操作的结果，更不能再次触发异常反馈。
    return undefined;
  }
}
