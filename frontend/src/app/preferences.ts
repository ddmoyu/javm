import type { MantineColorSchemeManager } from "@mantine/core";
import type { Runtime } from "../platform/neutralino/bootstrap";
import { nativeSettingsStorage } from "../platform/neutralino/settingsStorage";
import { migrateSettings } from "../services/metadata/shared";
import { discoverCardWidth, UiPreferencesService } from "../services/settings/UiPreferencesService";
import type { UiPreferences } from "../services/settings/UiPreferencesService";

const key = "javm-ui-preferences-v1";

function readLegacyPreferences(): Partial<UiPreferences> | null {
  const result: Partial<UiPreferences> = {};
  const scheme = localStorage.getItem("javm:color-scheme");
  if (scheme !== null) {
    if (scheme !== "light" && scheme !== "dark" && scheme !== "auto")
      throw new Error("旧主题设置格式无效");
    result.colorScheme = scheme;
  }
  const width = localStorage.getItem("javm:discover-card-width");
  if (width !== null) {
    const value = Number(width);
    if (!Number.isFinite(value) || value < discoverCardWidth.min || value > discoverCardWidth.max)
      throw new Error("旧卡片宽度设置格式无效");
    result.discoverCardWidth = value;
  }
  const raw = localStorage.getItem("javm:preferences");
  if (raw !== null) {
    const legacy: unknown = JSON.parse(raw);
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
      throw new Error("旧界面偏好格式无效");
    for (const field of ["cardClickToPlay", "navCollapsed"] as const) {
      if (!(field in legacy)) continue;
      const value: unknown = (legacy as Record<string, unknown>)[field];
      if (typeof value !== "boolean") throw new Error("旧界面偏好字段格式无效");
      result[field] = value;
    }
  }
  return Object.keys(result).length ? result : null;
}

let service: UiPreferencesService | undefined;
export function createUiPreferences(runtime: Runtime) {
  if (service) return service;
  const store =
    runtime === "desktop"
      ? nativeSettingsStorage<UiPreferences>(key)
      : {
          read: async (): Promise<unknown> => JSON.parse(localStorage.getItem(key) ?? "null"),
          write: async (value: UiPreferences) => localStorage.setItem(key, JSON.stringify(value)),
        };
  // 独立播放器与主窗口同源；通知只触发重读，设置仍以官方存储为准。
  let channel: BroadcastChannel | undefined;
  try {
    if (runtime === "desktop" && "BroadcastChannel" in window)
      channel = new BroadcastChannel(`javm-ui-preferences:${window.NL_DATAPATH}`);
  } catch {
    // 通道不可用时，窗口重新获得焦点仍会刷新设置。
  }
  const changed = () => {
    try {
      channel?.postMessage("changed");
    } catch {
      // 同步通知失败不改变已经完成的持久化结果。
    }
  };
  const preferences = new UiPreferencesService(
    {
      read: () => store.read(),
      async write(value) {
        await store.write(value);
        changed();
      },
      async migrate(value) {
        const current = await migrateSettings(store, value);
        changed();
        return current;
      },
    },
    {
      colorScheme: "dark",
      cardClickToPlay: true,
      navCollapsed: window.matchMedia("(max-width: 850px)").matches,
      discoverCardWidth: discoverCardWidth.fallback,
    },
    readLegacyPreferences,
  );
  const refresh = () => void preferences.refresh();
  const storageChanged = (event: StorageEvent) => {
    if (event.key === key || event.key === null) refresh();
  };
  if (channel) channel.onmessage = refresh;
  window.addEventListener("focus", refresh);
  if (runtime === "browser") window.addEventListener("storage", storageChanged);
  window.addEventListener(
    "pagehide",
    () => {
      channel?.close();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", storageChanged);
    },
    { once: true },
  );
  service = preferences;
  void preferences.initialize();
  return preferences;
}

export function uiColorSchemeManager(preferences: UiPreferencesService): MantineColorSchemeManager {
  let unsubscribe: (() => void) | undefined;
  const set: MantineColorSchemeManager["set"] = (colorScheme) => {
    if (colorScheme !== preferences.getSnapshot().value.colorScheme)
      void preferences.update({ colorScheme });
  };
  return {
    get: () => preferences.getSnapshot().value.colorScheme,
    set,
    clear: () => set("dark"),
    subscribe(onUpdate) {
      unsubscribe?.();
      let previous = preferences.getSnapshot().value.colorScheme;
      unsubscribe = preferences.subscribe(() => {
        const current = preferences.getSnapshot().value.colorScheme;
        if (current !== previous || preferences.getSnapshot().error) {
          previous = current;
          onUpdate(current);
        }
      });
    },
    unsubscribe: () => unsubscribe?.(),
  };
}
