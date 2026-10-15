import { app, clipboard, events, filesystem, init } from "@neutralinojs/lib";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { FeedbackDialog } from "../../../frontend/src/features/feedback/FeedbackDialog";
import { FeedbackService } from "../../../frontend/src/services/feedback/FeedbackService";
import {
  createFeedbackJournal,
  systemInformation,
} from "../../../frontend/src/platform/neutralino/feedback";
import { createApplicationLogs } from "../../../frontend/src/platform/neutralino/logging";
import { copyText } from "../../../frontend/src/platform/neutralino/clipboard";
import { issuesUrl } from "../../../frontend/src/services/feedback/report";

// 隔离宿主仅加载此安全页面；不加载主应用、不启用扩展、不请求内容源。
init();
await new Promise<void>((resolve) => {
  void events.on("ready", () => resolve());
});
const parameters = new URLSearchParams(location.search);
const root = parameters.get("root")!;
const phase = parameters.get("phase")!;
const normalized = (path: string) => path.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
if (normalized(window.NL_DATAPATH) !== normalized(root)) throw new Error("验证数据目录没有隔离");
const result: Record<string, unknown> = { ok: false, phase };
const journal = createFeedbackJournal();
const logs = createApplicationLogs("desktop");
const opened: string[] = [];
let browserClipboardCalled = false;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async () => {
      browserClipboardCalled = true;
      throw new Error("桌面端误用了浏览器剪贴板");
    },
  },
});
const service = new FeedbackService(logs, {
  read: journal.read,
  begin: journal.begin,
  write: journal.write,
  warning: journal.warning,
  system: systemInformation,
  copy: copyText,
  open: async (url) => {
    opened.push(url);
  }, // 验证交接地址，不打开或提交外部网页。
});
const ui = createRoot(document.getElementById("root")!);
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const limit = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= limit) throw new Error("桌面反馈验证等待超时");
    await pause();
  }
}
function require(value: boolean, message: string) {
  if (!value) throw new Error(message);
}
let previousText: string | undefined;
try {
  await service.initialize();
  ui.render(
    <MantineProvider>
      <FeedbackDialog service={service} />
    </MantineProvider>,
  );
  if (phase === "crash") {
    logs.record({
      level: "info",
      module: "downloads",
      event: "fixture",
      message: "安全桌面下载前日志",
      context: { taskId: "safe-download" },
    });
    const url =
      "https://media.example.invalid/demo.m3u8?token=full-safe-token&signature=safe-signature";
    const id = service.capture({
      module: "downloads",
      title: "安全下载失败",
      message: "安全样例缺少 2 个分片",
      taskId: "safe-download",
      url,
    });
    logs.record({
      level: "info",
      module: "downloads",
      event: "fixture",
      message: "安全桌面下载后日志",
      context: { taskId: "safe-download" },
    });
    await until(() => !!service.getSnapshot().reports.find((item) => item.id === id)?.complete);
    const report = service.getSnapshot().reports.find((item) => item.id === id)!;
    result.systemInformation = ["操作系统", "CPU", "物理内存"].every(
      (key) => !!report.system[key] && report.system[key] !== "未能采集",
    );
    require(result.systemInformation === true, "系统信息采集不完整");
    if ((await clipboard.getFormat()) === "text") {
      previousText = await clipboard.readText(); // 仅内存保留并原样恢复，不写日志或结果文件。
      const button = () =>
        [...document.querySelectorAll("button")].find(
          (item) => item.textContent?.trim() === "反馈问题",
        );
      await until(() => !!button() && !button()!.disabled);
      button()!.click();
      await until(() => document.body.textContent?.includes("粘贴提交即可") === true);
      const text = await clipboard.readText();
      result.clipboard =
        text.includes(url) &&
        text.includes("安全桌面下载前日志") &&
        text.includes("安全桌面下载后日志") &&
        text.includes(report.system.CPU!);
      require(result.clipboard === true, "正式反馈按钮的原生剪贴板读回不匹配");
      require(opened.length === 1 &&
        opened[0] === issuesUrl &&
        !browserClipboardCalled, "剪贴板或 GitHub 交接不正确");
      await clipboard.writeText(previousText);
      result.clipboardRestored = (await clipboard.readText()) === previousText;
      require(result.clipboardRestored === true, "剪贴板原文本恢复失败");
      previousText = undefined;
    } else result.clipboard = "跳过：保留现有非文本剪贴板";
    logs.record({ level: "info", module: "app", event: "fixture", message: "安全桌面崩溃前日志" });
    await logs.flush();
    await pause(600);
    result.session = logs.getSession();
    result.dataPath = window.NL_DATAPATH;
    // 保持运行，由测试父进程结束整个测试 Job，故意不调用 prepareExit。
  } else {
    const crashes = service.getSnapshot().reports.filter((item) => item.title === "上次未正常退出");
    if (phase === "recover") {
      require(crashes.length === 1, "强制结束后没有恢复唯一的异常退出报告");
      require(service.getSnapshot().activeId === crashes[0]!.id, "恢复启动没有提示反馈");
      require(crashes[0]!.before.includes("安全桌面崩溃前日志"), "恢复报告缺少上一会话日志");
      require(!!crashes[0]!.system.CPU, "恢复报告缺少原系统快照");
      require(service
        .getSnapshot()
        .reports.some((item) =>
          item.url?.includes("token=full-safe-token"),
        ), "损坏快照导致下载报告丢失");
      require(journal.warning().includes("不完整"), "未识别注入的中断写入");
      result.crashPrompt = true;
      result.previousLogs = true;
      result.snapshotFallback = true;
    } else {
      require(crashes.length === 1 && !service.getSnapshot().activeId, "正常退出后重复提示崩溃");
      result.normalExit = true;
    }
    await service.prepareExit();
    await logs.shutdown();
    result.sessionMarkers = (
      await filesystem.readDirectory(`${window.NL_DATAPATH}/diagnostics`)
    ).filter((item) => item.entry.startsWith("session-")).length;
    require(result.sessionMarkers === 0, "正常退出标记未清除");
  }
  result.ok = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : "安全桌面反馈验证失败";
} finally {
  if (previousText !== undefined) await clipboard.writeText(previousText);
  await filesystem.writeFile(`${root}/${phase}.json`, JSON.stringify(result, null, 2));
  if (phase !== "crash" || !result.ok) {
    ui.unmount();
    service.dispose();
    await app.exit();
  }
}
