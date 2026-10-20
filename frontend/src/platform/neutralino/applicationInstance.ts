import { app, window as nativeWindow } from "@neutralinojs/lib";
import { NativeLibraryPort } from "./library";
import { parseLaunchArguments } from "../../services/settings/deepLinks";
import type { LaunchAction } from "../../services/settings/deepLinks";
import { getPrivacySession, privacyRevision } from "../../services/privacy/session";
import { restorePrivateWindow } from "./privacy";
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
  const pending: { args: string[]; actions?: LaunchAction[] }[] = [];
  const poll = async () => {
    if (stopped || cancelled) return;
    try {
      // 原生每批最多 32 条；锁定时只唤起锁屏，动作留在有上限的队列中。
      if (pending.length <= 32) {
        const revision = privacyRevision();
        const incoming = await port.request<string[][]>("library.instance.take");
        pending.push(...incoming.map((args) => ({ args })));
        if (incoming.length && revision === privacyRevision()) await restorePrivateWindow();
      }
      while (pending.length) {
        if (stopped || cancelled) return;
        if (getPrivacySession().protected) return;
        const request = pending[0]!;
        try {
          request.actions ??= parseLaunchArguments(request.args);
          while (request.actions.length) {
            if (getPrivacySession().protected) return;
            await handle(request.actions.shift()!);
          }
        } catch (e) {
          report(e instanceof Error ? e.message : "启动请求失败");
        }
        pending.shift();
      }
    } catch (e) {
      if (!stopped && !cancelled) report(e instanceof Error ? e.message : "启动请求读取失败");
    } finally {
      if (!stopped && !cancelled) timer = setTimeout(() => void poll(), 1500);
    }
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
