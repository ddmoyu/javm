import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  compatibleAny,
  compatibleTimeout,
  installAbortCompatibility,
} from "../frontend/src/platform/abortCompatibility";

afterEach(() => vi.useRealTimers());
describe("macOS 13 取消与超时兼容", () => {
  it("已取消的输入保留首个原因且不添加监听", () => {
    const parent = new AbortController(),
      second = new AbortController();
    parent.abort("safe-reason");
    second.abort("later");
    expect(compatibleAny([parent.signal, second.signal]).reason).toBe("safe-reason");
  });
  it("去重监听，首次取消传播原因并清理所有父信号", () => {
    const a = new AbortController(),
      b = new AbortController();
    const add = vi.spyOn(a.signal, "addEventListener");
    const removeA = vi.spyOn(a.signal, "removeEventListener"),
      removeB = vi.spyOn(b.signal, "removeEventListener");
    const signal = compatibleAny([a.signal, b.signal, a.signal]);
    expect(add).toHaveBeenCalledTimes(1);
    const reason = new Error("safe cancellation");
    b.abort(reason);
    expect(signal.reason).toBe(reason);
    expect(removeA).toHaveBeenCalledTimes(1);
    expect(removeB).toHaveBeenCalledTimes(1);
    a.abort("later");
    expect(signal.reason).toBe(reason);
  });
  it("超时使用 TimeoutError，定时之前不会提前取消", () => {
    vi.useFakeTimers();
    const signal = compatibleTimeout(100);
    vi.advanceTimersByTime(99);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.reason.name).toBe("TimeoutError");
    expect(() => compatibleTimeout(-1)).toThrow(RangeError);
  });
  it("保留已有原生实现，空信号集合不会取消", () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, "any"),
      timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    installAbortCompatibility();
    expect(Object.getOwnPropertyDescriptor(AbortSignal, "any")).toEqual(any);
    expect(Object.getOwnPropertyDescriptor(AbortSignal, "timeout")).toEqual(timeout);
    expect(compatibleAny([]).aborted).toBe(false);
  });
});
