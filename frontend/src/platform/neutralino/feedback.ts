import { computer, filesystem, os, storage } from "@neutralinojs/lib";
import type { Runtime } from "./bootstrap";
import { createApplicationLogs } from "./logging";
import { copyText } from "./clipboard";
import { waitForUpdateStartup } from "./updateGate";
import { nativeSettingsStorage } from "./settingsStorage";
import { FeedbackService, deadline } from "../../services/feedback/FeedbackService";
import { setFailureSink } from "../../services/feedback/events";
import { captureUnhandledErrors } from "../../services/logging/events";
import type { SystemDetails } from "../../services/feedback/report";
import { FeedbackJournal, feedbackFileLimit } from "../../services/feedback/persistence";
import packageInfo from "../../../../package.json";

const key = "failure-feedback-v1";
let service: FeedbackService | undefined;
export async function systemInformation(): Promise<SystemDetails> {
  const information: SystemDetails = {
    JAVM: packageInfo.version,
    采集时间: new Date().toISOString(),
    平台: window.NL_OS,
    应用架构: window.NL_ARCH,
    Neutralino: window.NL_VERSION,
    Neutralino客户端: window.NL_CVERSION,
    WebView: navigator.userAgent,
    语言: navigator.language,
    时区: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  // 每项独立降级，不读取主机名、设备 ID、IP、MAC、环境变量或用户设置。
  await Promise.allSettled([
    deadline(computer.getOSInfo(), 2000)
      .then((value) => {
        information.操作系统 = `${value.name} ${value.version} ${value.description}`;
      })
      .catch(() => {
        information.操作系统 = "未能采集";
      }),
    deadline(computer.getCPUInfo(), 2000)
      .then((value) => {
        information.CPU = `${value.model}；${value.physicalCores} 核 / ${value.logicalThreads} 线程；${value.architecture}`;
      })
      .catch(() => {
        information.CPU = "未能采集";
      }),
    deadline(computer.getMemoryInfo(), 2000)
      .then((value) => {
        const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
        information.物理内存 = `总量 ${gib(value.physical.total)}；采集时可用 ${gib(value.physical.available)}`;
      })
      .catch(() => {
        information.物理内存 = "未能采集";
      }),
  ]);
  return information;
}

export function createFeedbackJournal() {
  const directory = `${window.NL_DATAPATH}/diagnostics`;
  const path = (name: string) => {
    if (!/^(report|session)-[\da-f-]+\.json$/.test(name)) throw new Error("诊断文件名无效");
    return `${directory}/${name}`;
  };
  return new FeedbackJournal(
    {
      async list() {
        try {
          return (await filesystem.readDirectory(directory))
            .filter((item) => item.type === "FILE")
            .map((item) => item.entry);
        } catch (error) {
          try {
            await filesystem.getStats(directory);
          } catch (statError) {
            if ((statError as { code?: string }).code === "NE_FS_NOPATHE") return [];
          }
          throw error;
        }
      },
      async read(name) {
        if ((await filesystem.getStats(path(name))).size > feedbackFileLimit * 4)
          throw new Error("诊断文件过大");
        return filesystem.readFile(path(name));
      },
      async write(name, text) {
        await waitForUpdateStartup();
        await filesystem.createDirectory(directory).catch(async (error: unknown) => {
          if (!(await filesystem.getStats(directory)).isDirectory) throw error;
        });
        await filesystem.writeFile(path(name), text);
      },
      async remove(name) {
        await waitForUpdateStartup();
        try {
          await filesystem.remove(path(name));
        } catch (error) {
          try {
            await filesystem.getStats(path(name));
          } catch (statError) {
            if ((statError as { code?: string }).code === "NE_FS_NOPATHE") return;
          }
          throw error;
        }
      },
    },
    async () => {
      let keys: string[];
      try {
        keys = await storage.getKeys();
      } catch (error) {
        if ((error as { code?: string }).code === "NE_ST_NOSTDIR") {
          try {
            await filesystem.getStats(`${window.NL_DATAPATH}/.storage`);
          } catch (statError) {
            if ((statError as { code?: string }).code === "NE_FS_NOPATHE") return null;
          }
        }
        throw error;
      }
      if (!keys.includes(key)) return null;
      const text = await storage.getData(key);
      if (text.length > 1024 * 1024) throw new Error("反馈记录过大，原文件已保留。");
      return JSON.parse(text) as unknown;
    },
  );
}
export function createApplicationFeedback(runtime: Runtime) {
  if (runtime !== "desktop") return undefined;
  if (service) return service;
  const journal = createFeedbackJournal();
  service = new FeedbackService(createApplicationLogs(runtime), {
    settings: nativeSettingsStorage<{ enabled: boolean }>("javm-feedback-settings-v1"),
    startup: waitForUpdateStartup,
    listen: captureUnhandledErrors,
    read: journal.read,
    begin: journal.begin,
    end: journal.end,
    warning: journal.warning,
    write: journal.write,
    system: systemInformation,
    copy: copyText,
    open: (url) => os.open(url),
  });
  setFailureSink(service.capture);
  void service.initialize();
  return service;
}
export function prepareFeedbackExit() {
  return service?.prepareExit();
}
export function resumeFeedbackAfterFailedExit() {
  return service?.resumeAfterFailedExit();
}
