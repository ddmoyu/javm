import { filesystem, storage } from "@neutralinojs/lib";
import { logEvent } from "../../services/logging/events";

export function nativeSettingsStorage<T>(key: string) {
  return {
    async read(): Promise<unknown> {
      try {
        const keys = await storage.getKeys();
        return keys.includes(key) ? (JSON.parse(await storage.getData(key)) as unknown) : null;
      } catch (error) {
        if ((error as { code?: string }).code === "NE_ST_NOSTDIR") {
          try {
            await filesystem.getStats(`${window.NL_DATAPATH}/.storage`);
          } catch (statError) {
            if ((statError as { code?: string }).code === "NE_FS_NOPATHE") return null;
          }
        }
        logEvent("error", "settings", "read_failed", "无法读取设置", { setting: key });
        throw error;
      }
    },
    async write(value: T) {
      try {
        await storage.setData(key, JSON.stringify(value));
      } catch (error) {
        logEvent("error", "settings", "save_failed", "无法保存设置", { setting: key });
        throw error;
      }
    },
  };
}
