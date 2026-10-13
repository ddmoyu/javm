// macOS 13 的系统 WebKit 已支持 AbortController，但不一定提供 any / timeout。
// 合并信号不会让长寿命的父信号持有已完成任务；目标被回收后移除监听器。
const controllers = new WeakMap<AbortSignal, AbortController>();
const finalizers = new FinalizationRegistry<() => void>((dispose) => dispose());

export function compatibleAny(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const unique = [...new Set(signals)];
  for (const source of unique) {
    if (!(source instanceof AbortSignal)) throw new TypeError("Invalid AbortSignal");
    if (source.aborted) {
      controller.abort(source.reason);
      return controller.signal;
    }
  }
  const token = {};
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = makeDisposer(listeners, token);
  const target = new WeakRef(controller.signal);
  controllers.set(controller.signal, controller);
  for (const source of unique) {
    // 只捕获弱引用，不能在监听器中闭包捕获 controller。
    const listener = makeListener(target, source, dispose);
    listeners.set(source, listener);
    source.addEventListener("abort", listener, { once: true });
  }
  finalizers.register(controller.signal, dispose, token);
  return controller.signal;
}
function makeDisposer(listeners: Map<AbortSignal, () => void>, token: object) {
  return () => {
    for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
    listeners.clear();
    finalizers.unregister(token);
  };
}
function makeListener(target: WeakRef<AbortSignal>, source: AbortSignal, dispose: () => void) {
  return () => {
    const signal = target.deref();
    dispose();
    if (signal) {
      controllers.get(signal)?.abort(source.reason);
      controllers.delete(signal);
    }
  };
}
export function compatibleTimeout(milliseconds: number): AbortSignal {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647)
    throw new RangeError("Invalid abort timeout");
  const controller = new AbortController();
  setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    milliseconds,
  );
  return controller.signal;
}
export function installAbortCompatibility() {
  if (typeof AbortSignal.any !== "function")
    Object.defineProperty(AbortSignal, "any", {
      value: compatibleAny,
      configurable: true,
      writable: true,
    });
  if (typeof AbortSignal.timeout !== "function")
    Object.defineProperty(AbortSignal, "timeout", {
      value: compatibleTimeout,
      configurable: true,
      writable: true,
    });
}
