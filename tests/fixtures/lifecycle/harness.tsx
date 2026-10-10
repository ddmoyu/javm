import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { events, filesystem, window as nativeWindow } from "@neutralinojs/lib";
import { initializePlatform } from "../../../frontend/src/platform/neutralino/bootstrap";
import { createMainView } from "../../../frontend/src/app/mainView";
import {
  createLibraryService,
  NativeLibraryPort,
} from "../../../frontend/src/platform/neutralino/library";
import { createDownloadTasks } from "../../../frontend/src/services/downloads/input";
import type { DownloadTask } from "../../../frontend/src/contracts/downloads";
import { createBackgroundSettings } from "../../../frontend/src/platform/neutralino/backgroundSettings";
import { createApplicationLogs } from "../../../frontend/src/platform/neutralino/logging";
import { logEvent } from "../../../frontend/src/services/logging/events";
import { isLogFile } from "../../../frontend/src/services/logging/RotatingLogStore";
import packageInfo from "../../../package.json";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";

const runtime = initializePlatform();
document.documentElement.dataset.runtime = runtime;
const params = new URLSearchParams(location.search);
const phase = params.get("phase")!;
const resultPath = params.get("result")!;
const exceptions: string[] = [];
const results: string[] = [];
let animationFrameObserved = false;
requestAnimationFrame(() => {
  animationFrameObserved = true;
});
window.addEventListener("error", (event) => exceptions.push(event.message));
window.addEventListener("unhandledrejection", (event) => exceptions.push(String(event.reason)));
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider
      env="test"
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      {createMainView(runtime)}
    </MantineProvider>
  </StrictMode>,
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = performance.now() + 15000;
  while (!(await check())) {
    if (performance.now() > end) throw new Error(`等待超时：${label}`);
    await sleep(50);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const writeResult = (extra = {}) =>
  filesystem.writeFile(
    resultPath,
    JSON.stringify(
      { done: true, phase, results, exceptions, animationFrameObserved, ...extra },
      null,
      2,
    ),
  );

async function run() {
  await nativeWindow.show();
  await nativeWindow.focus();
  await until(() => createLibraryService(runtime).getSnapshot().ready, "隔离数据库就绪");
  assert(createLibraryService(runtime).getSnapshot().databasePath, "数据库未连接成功");
  await until(() => !!document.querySelector("#main-navigation button"), "主界面");
  const settings = [...document.querySelectorAll<HTMLButtonElement>(".sidebar button")].find(
    (button) => /^(系统设置|设置)$/.test(button.textContent || ""),
  );
  assert(settings, "缺少设置入口");
  settings.click();
  const toggle = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="关闭窗口后留在托盘"]');
  await until(() => !!toggle() && !toggle()!.disabled, "后台运行设置就绪");
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭窗口"]');
  assert(close, "缺少标题栏关闭按钮");
  const logs = createApplicationLogs(runtime);
  const logDirectory = logs.getSnapshot().directory;
  const database = new NativeLibraryPort();
  await until(() => {
    const form = document.querySelector('form[aria-label="下载设置"]');
    return !!form && !form.textContent!.includes("正在读取下载设置");
  }, "下载服务就绪");
  assert(!document.body.textContent!.includes("下载服务不可用"), "下载服务初始化失败");

  if (phase === "first") {
    const sectionButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="设置分类"] button')].find(
        (item) => item.textContent === label,
      )!;
    sectionButton("关于 JAVM").click();
    await until(() => !document.getElementById("settings-about")?.hidden, "关于页面");
    const about = document.getElementById("settings-about")!;
    assert(about.textContent!.split(packageInfo.version).length - 1 === 1, "关于页面版本号重复");
    assert(
      !about.textContent!.includes("运行环境") && !about.textContent!.includes("下载任务日志"),
      "仍存在已移除条目",
    );
    assert(
      !document
        .querySelector('nav[aria-label="设置分类"]')!
        .parentElement!.textContent!.includes(packageInfo.version),
      "侧边栏仍显示冗余版本号",
    );
    results.push("仅保留当前版本，运行环境与下载日志入口已移除");
    for (let index = 0; index < 20; index++)
      logEvent("info", "logging", "unicode_fixture", "中文日志片段".repeat(300));
    logEvent(
      "warn",
      "downloads",
      "fixture",
      "统一日志验证 https://name:password@host/video?token=secret",
      { taskId: "fixture-task" },
    );
    [...about.querySelectorAll("button")].find((item) => item.textContent === "查看日志")!.click();
    await until(
      () =>
        !!document.querySelector('dialog, [role="dialog"]')?.textContent?.includes("统一日志验证"),
      "日志查看器读取真实文件",
    );
    assert(
      !document.querySelector('[role="dialog"]')!.textContent!.includes("�"),
      "日志尾部读取破坏了中文编码",
    );
    assert(!logs.getSnapshot().error, logs.getSnapshot().error);
    const files = (await filesystem.readDirectory(logDirectory)).filter((file) =>
      isLogFile(file.entry),
    );
    assert(files.length > 0, "没有落盘日志");
    for (const file of files) {
      const text = await filesystem.readFile(`${logDirectory}/${file.entry}`);
      assert(!/password|token=secret/.test(text), "日志没有脱敏");
      for (const line of text.trim().split("\n")) {
        const record = JSON.parse(line);
        assert(
          record.time && record.level && record.module && record.event && record.session,
          "日志缺少标准字段",
        );
      }
    }
    results.push("统一日志可查看且实际文件包含标准字段和脱敏内容");
    assert(
      (
        await Promise.all(files.map((file) => filesystem.getStats(`${logDirectory}/${file.entry}`)))
      ).some((file) => file.size > 64 * 1024),
      "没有覆盖跨中文边界的 64 KiB 尾部读取",
    );
    results.push("大于 64 KiB 的中文日志可安全读取尾部");
    document.querySelector<HTMLButtonElement>('button[aria-label="关闭对话框"]')!.click();
    await until(() => !document.querySelector('dialog[open], [role="dialog"]'), "关闭日志查看器");
    sectionButton("外观与交互").click();
    const old = `javm-${Date.now() - 8 * 86400000}-012345ab-1.jsonl`;
    await filesystem.writeFile(`${logDirectory}/${old}`, "expired fixture\n");
    await filesystem.writeFile(`${logDirectory}/keep.txt`, "unrelated fixture");
    for (let index = 0; index < 11; index++)
      await filesystem.writeFile(
        `${logDirectory}/javm-${Date.now() - index * 1000}-012345ab-${index + 2}.jsonl`,
        "fixture\n",
      );
    const legacy = createDownloadTasks(
      {
        urls: ["https://example.invalid/legacy-log.mp4"],
        directory: window.NL_DATAPATH,
        kind: "auto",
        headers: {},
      },
      [],
    )[0]!;
    await database.request("downloads.save", {
      task: {
        ...legacy,
        name: "旧下载日志迁移验证",
        status: "paused",
        log: ["旧日志迁移 https://example.invalid/video?token=legacy-secret"],
        revision: 1,
      },
      expectedRevision: 0,
    });
    assert(toggle()!.checked, "首次启动未默认开启后台运行");
    results.push("首次启动默认开启");
    close.click();
    await until(async () => !(await nativeWindow.isVisible()), "标题栏关闭后隐藏主窗口");
    results.push("标题栏关闭后宿主继续运行且窗口隐藏");
    await nativeWindow.show();
    await events.dispatch("windowClose");
    await until(async () => !(await nativeWindow.isVisible()), "系统关闭事件隐藏主窗口");
    results.push("系统关闭事件遵循开启设置");
    await nativeWindow.show();
    toggle()!.click();
    await until(() => !toggle()!.checked && !toggle()!.disabled, "关闭后台运行并完成保存");
    assert(
      !(await createBackgroundSettings(runtime).shouldRunInBackground()),
      "开关未保存到桌面存储",
    );
    results.push("关闭开关后已持久化且立即生效");
    await writeResult();
    await events.dispatch("windowClose");
  } else if (phase === "restart") {
    await logs.flush();
    const files = await filesystem.readDirectory(logDirectory);
    const kept = files.filter((file) => isLogFile(file.entry));
    assert(kept.length <= 10, "日志数量超过 10 个");
    assert(
      kept.every((file) => Number(file.entry.split("-")[1]) >= Date.now() - 7 * 86400000),
      "过期日志没有清理",
    );
    assert(
      files.some((file) => file.entry === "keep.txt"),
      "错误清理了非日志文件",
    );
    results.push("重启清理 7 天前记录和超量文件，保留非日志文件");
    const saved = await database.request<{ tasks: DownloadTask[] }>("downloads.load");
    const migrated = saved.tasks.find((task) => task.name === "旧下载日志迁移验证");
    assert(migrated && migrated.log.length === 0 && migrated.revision > 1, "旧日志副本没有清理");
    const entries = await logs.recent();
    assert(
      entries.some(
        (entry) => entry.event === "legacy_output" && entry.context?.taskId === migrated.id,
      ) && !JSON.stringify(entries).includes("legacy-secret"),
      "近期旧日志没有安全迁移到统一日志",
    );
    results.push("旧下载日志落盘后清理数据库副本，迁移内容已脱敏");
    assert(!toggle()!.checked, "重启未恢复关闭状态");
    results.push("重启后读取关闭状态");
    await writeResult();
    close.click();
  } else {
    assert(!toggle()!.checked, "托盘退出验证缺少已保存设置");
    toggle()!.click();
    await until(() => toggle()!.checked && !toggle()!.disabled, "重新开启后台运行");
    results.push("重新开启后台运行自动保存");
    await writeResult();
    await events.dispatch("trayMenuItemClicked", { id: "exit" });
  }
}
void run().catch(async (error: unknown) => {
  await filesystem.writeFile(
    resultPath.replace(".json", ".html"),
    document.documentElement.outerHTML,
  );
  await writeResult({
    fatal: String(error),
    logs: createApplicationLogs(runtime).getSnapshot(),
    dialog: document.querySelector('dialog, [role="dialog"]')?.textContent,
    buttons: [...document.querySelectorAll<HTMLButtonElement>("#settings-about button")].map(
      (button) => ({ text: button.textContent, disabled: button.disabled, html: button.outerHTML }),
    ),
  });
});
