import { filesystem, os } from "@neutralinojs/lib";
import { LogService } from "../../services/logging/LogService";
import { RotatingLogStore, isLogFile } from "../../services/logging/RotatingLogStore";
import { captureUnhandledErrors, logEvent, setLogSink } from "../../services/logging/events";
import type { Runtime } from "./bootstrap";
import packageInfo from "../../../../package.json";

let service: LogService | undefined;
export function createApplicationLogs(runtime: Runtime) {
  if (service) return service;
  const directory = `${window.NL_DATAPATH}/logs`;
  const port = {
    directory,
    async list() {
      try {
        await filesystem.createDirectory(directory);
      } catch (error) {
        if (!(await filesystem.getStats(directory).catch(() => null))?.isDirectory) throw error;
      }
      const files = await filesystem.readDirectory(directory);
      const result: { name: string; size: number }[] = [];
      for (const file of files) {
        if (!isLogFile(file.entry)) continue;
        const stat = await filesystem.getStats(`${directory}/${file.entry}`);
        if (stat.isFile) result.push({ name: file.entry, size: stat.size });
      }
      return result;
    },
    append: (name: string, content: string) =>
      filesystem.appendFile(`${directory}/${name}`, content),
    remove: (name: string) => filesystem.remove(`${directory}/${name}`),
    async tail(name: string, bytes: number) {
      const file = `${directory}/${name}`;
      const stat = await filesystem.getStats(file);
      const pos = Math.max(0, stat.size - bytes);
      // 字节窗口可能落在中文的 UTF-8 编码中间，先按二进制读取再丢弃首条残行。
      const data = await filesystem.readBinaryFile(file, { pos, size: bytes });
      const text = new TextDecoder().decode(data);
      return pos ? text.slice(text.indexOf("\n") + 1) : text;
    },
    openDirectory: () => os.open(directory),
  };
  service = new LogService(runtime === "desktop" ? new RotatingLogStore(port) : undefined);
  if (runtime === "desktop") {
    setLogSink(
      service.record,
      service.flush,
      () => !service!.getSnapshot().error && !service!.getSnapshot().dropped,
    );
    captureUnhandledErrors();
    service.initialize();
    logEvent("info", "app", "started", "应用已启动", { version: packageInfo.version });
  }
  return service;
}
