import { filesystem, storage } from "@neutralinojs/lib";
import { logEvent } from "../../services/logging/events";
import { waitForUpdateStartup } from "./updateGate";

const writes = new Map<string, { tail: Promise<void>; count: number }>();
function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const queue = writes.get(key) ?? { tail: Promise.resolve(), count: 0 };
  if (queue.count >= 16) return Promise.reject(new Error("设置保存请求过多，请稍后重试。"));
  writes.set(key, queue);
  ++queue.count;
  const job = queue.tail.then(async () => {
    await waitForUpdateStartup();
    return operation();
  });
  queue.tail = job.then(
    () => {},
    () => {},
  );
  void queue.tail.then(() => {
    if (--queue.count === 0) writes.delete(key);
  });
  return job;
}

export function nativeSettingsStorage<T>(key: string) {
  const read = async (): Promise<unknown> => {
    try {
      const keys = await storage.getKeys();
      if (!keys.includes(key)) return null;
      const value: unknown = JSON.parse(await storage.getData(key));
      // 只有缺少键才表示未配置；已有的空记录不能触发默认值或旧值覆盖。
      if (value === null) throw new Error("设置记录为空，原配置已保留。");
      return value;
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
  };
  const write = async (value: T) => {
    try {
      await storage.setData(key, JSON.stringify(value));
    } catch (error) {
      logEvent("error", "settings", "save_failed", "无法保存设置", { setting: key });
      throw error;
    }
  };
  return {
    read,
    write: (value: T) => serialize(key, () => write(value)),
    migrate: (create: () => T) =>
      serialize(key, async () => {
        // 检查必须在更新启动确认之后，并与此键的正常保存串行执行。
        const current = await read();
        if (current !== null) return current;
        const value = create();
        await write(value);
        return value;
      }),
  };
}
