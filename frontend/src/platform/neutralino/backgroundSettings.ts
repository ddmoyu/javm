import { BackgroundSettingsService } from "../../services/settings/BackgroundSettingsService";
import type { Runtime } from "./bootstrap";
import { nativeSettingsStorage } from "./settingsStorage";

export function createBackgroundSettings(runtime: Runtime) {
  const settings = new BackgroundSettingsService(
    nativeSettingsStorage("javm-background-settings-v1"),
    runtime === "desktop",
  );
  void settings.initialize();
  return settings;
}
