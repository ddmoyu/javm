import { matchesShortcut } from "./shortcuts";
import type { PrivacyShortcut } from "./shortcuts";

export interface PrivacySession {
  protected: boolean;
  localEnabled: boolean;
  localShortcut: PrivacyShortcut;
}
let state: PrivacySession = {
  protected: false,
  localEnabled: true,
  localShortcut: { key: "F1", modifier: "" },
};
let revision = 0;
let bossKey: (() => void) | undefined;
const listeners = new Set<() => void>();
export const getPrivacySession = () => state;
export const privacyRevision = () => revision;
export const subscribePrivacySession = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function assertPlaybackAllowed(version = revision) {
  if (state.protected || version !== revision)
    throw new Error("隐私保护已暂停播放，请恢复窗口后重新播放。");
}
export function silenceMedia(element: HTMLMediaElement) {
  if (!element.muted) element.muted = true;
  if (!element.paused) element.pause();
}
export function setPrivacySession(patch: Partial<PrivacySession>) {
  state = { ...state, ...patch };
  if (patch.protected === true) ++revision;
  document.documentElement.dataset.privacyProtected = String(state.protected);
  if (state.protected) {
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach(silenceMedia);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }
  for (const listener of listeners) listener();
}
export function bindBossKey(handler: () => void) {
  bossKey = handler;
}
export function triggerBossKey() {
  bossKey?.();
}
let bound = false;
export function initializePrivacyInput() {
  if (bound) return;
  bound = true;
  const focus = () => {
    document.documentElement.dataset.privacyUnfocused = String(!document.hasFocus());
  };
  window.addEventListener("blur", focus);
  window.addEventListener("focus", focus);
  focus();
  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-privacy-shortcut]")) return;
      if (state.localEnabled && matchesShortcut(event, state.localShortcut)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) triggerBossKey();
      } else if (
        state.protected &&
        !(event.target as HTMLElement | null)?.closest?.("[data-privacy-lock]")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  for (const name of ["play", "playing", "volumechange"])
    document.addEventListener(
      name,
      (event) => {
        if (state.protected && event.target instanceof HTMLMediaElement) silenceMedia(event.target);
      },
      true,
    );
}
