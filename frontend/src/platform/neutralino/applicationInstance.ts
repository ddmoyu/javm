import { app, window as nativeWindow } from "@neutralinojs/lib";
import { NativeLibraryPort } from "./library";
import { parseLaunchArguments } from "../../services/settings/deepLinks";
import type { LaunchAction } from "../../services/settings/deepLinks";
const port = new NativeLibraryPort();
let primary = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  stopped = false;
export async function claimApplicationInstance() {
  const raw = (window as unknown as { NL_ARGS?: unknown }).NL_ARGS;
  const args = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && /^javm:/i.test(item))
    : [];
  const result = await port.request<{ primary: boolean }>("library.instance.claim", { args });
  primary = result.primary;
  if (!primary) {
    await nativeWindow.hide();
    await app.exit();
  }
  return primary;
}
export function listenApplicationLaunches(
  handle: (action: LaunchAction) => Promise<void>,
  report: (message: string) => void,
) {
  if (!primary) return () => {};
  stopped = false;
  let cancelled = false;
  const poll = async () => {
    if (stopped || cancelled) return;
    try {
      const requests = await port.request<string[][]>("library.instance.take");
      for (const args of requests) {
        if (stopped || cancelled) return;
        try {
          if (await nativeWindow.isMinimized()) await nativeWindow.unminimize();
          await nativeWindow.show();
          await nativeWindow.focus();
          for (const action of parseLaunchArguments(args)) await handle(action);
        } catch (e) {
          report(e instanceof Error ? e.message : "启动请求失败");
        }
      }
    } catch (e) {
      if (!stopped && !cancelled) report(e instanceof Error ? e.message : "启动请求读取失败");
    }
    if (!stopped && !cancelled) timer = setTimeout(() => void poll(), 1500);
  };
  // 延后一拍避免 StrictMode 模拟卸载消费队列。
  timer = setTimeout(() => void poll(), 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
export function stopApplicationLaunches() {
  stopped = true;
  clearTimeout(timer);
}
