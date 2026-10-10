import { logEvent } from "./events";
import type { LogInput } from "./events";

export function observeLogState<T>(
  module: string,
  service: { getSnapshot(): T; subscribe(listener: () => void): () => void },
  select: (snapshot: T) => { state: string; error?: string; context?: LogInput["context"] },
) {
  let previous = select(service.getSnapshot());
  return service.subscribe(() => {
    const current = select(service.getSnapshot());
    if (current.error && current.error !== previous.error)
      logEvent("error", module, "failed", current.error, current.context);
    if (current.state !== previous.state)
      logEvent("info", module, "state_changed", current.state, current.context);
    previous = current;
  });
}
