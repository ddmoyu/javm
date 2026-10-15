import { events, window as nativeWindow } from "@neutralinojs/lib";
import type { Runtime } from "./bootstrap";
import { nativeSettingsStorage } from "./settingsStorage";
import { PrivacyService } from "../../services/privacy/PrivacyService";
import type { PrivacyRecord } from "../../services/privacy/PrivacyService";
import {
  bindBossKey,
  getPrivacySession,
  initializePrivacyInput,
  setPrivacySession,
  triggerBossKey,
} from "../../services/privacy/session";
import { privacyNative } from "./privacyNative";

let service: PrivacyService | undefined;
export function createPrivacyService(runtime: Runtime) {
  if (service) return service;
  let preview: PrivacyRecord | null = null;
  const windows = runtime === "desktop" && window.NL_OS === "Windows";
  let listening: Promise<unknown> | undefined;
  service = new PrivacyService(
    runtime === "desktop"
      ? nativeSettingsStorage<PrivacyRecord>("javm-privacy-v1")
      : {
          read: async () => preview,
          write: async (value) => {
            preview = value;
          },
        },
    async (settings) => {
      if (!windows) return;
      listening ??= events.on("javm.privacy.bossKey", triggerBossKey);
      await listening;
      await privacyNative.request("privacy.hotkey", {
        enabled: settings.globalEnabled,
        key: settings.globalShortcut.key,
        modifiers: { "": 0, Ctrl: 2, Alt: 1, Shift: 4 }[settings.globalShortcut.modifier],
        localEnabled: settings.localEnabled,
        localKey: settings.localShortcut.key,
        localModifiers: { "": 0, Ctrl: 2, Alt: 1, Shift: 4 }[settings.localShortcut.modifier],
      });
    },
    async (hidden) => {
      if (runtime !== "desktop") return;
      // 两条路径独立执行，扩展故障时仍通过官方窗口 API 隐藏主窗口。
      const results = await Promise.allSettled([
        windows ? privacyNative.request("privacy.hide", { hideMain: hidden }) : Promise.resolve(),
        hidden ? nativeWindow.hide() : Promise.resolve(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("部分窗口隐藏失败，内容已遮挡；请检查隐私设置。");
    },
  );
  const current = service;
  const synchronize = () => {
    const snapshot = current.getSnapshot();
    const protectedContent = !snapshot.ready || snapshot.locked || snapshot.hidden;
    document.documentElement.dataset.privacyBlur = String(snapshot.settings.blurImages);
    const previous = getPrivacySession();
    setPrivacySession({
      ...(previous.protected !== protectedContent ? { protected: protectedContent } : {}),
      localEnabled: snapshot.settings.localEnabled,
      localShortcut: snapshot.settings.localShortcut,
    });
  };
  current.subscribe(synchronize);
  synchronize();
  initializePrivacyInput();
  bindBossKey(() => {
    void current.conceal().catch(() => {
      /* 保持遮挡，恢复后由设置页显示状态。 */
    });
  });
  return current;
}

export async function restorePrivateWindow() {
  const revision = service?.getConcealRevision();
  if ((await service?.restore()) === false) return;
  if ("NL_PORT" in window) {
    const concealedAgain = () => revision !== service?.getConcealRevision();
    if (await nativeWindow.isMinimized()) await nativeWindow.unminimize();
    if (concealedAgain()) {
      await nativeWindow.hide();
      return;
    }
    await nativeWindow.show();
    if (concealedAgain()) {
      await nativeWindow.hide();
      return;
    }
    await nativeWindow.focus();
    if (concealedAgain()) await nativeWindow.hide();
  }
}
