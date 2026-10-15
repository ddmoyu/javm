import { logEvent } from "../services/logging/events";
import { initializeContextMenu } from "./contextMenu";

const splash = document.getElementById("startup");
const status = document.getElementById("startup-status");
const retry = document.getElementById("startup-retry");
const feedback = document.getElementById("startup-feedback") as HTMLButtonElement | null;
let startupError: unknown;
let completed = false;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

function moduleError(event: Event) {
  if (event instanceof ErrorEvent || event.target instanceof HTMLScriptElement)
    failStartup(event instanceof ErrorEvent ? event.error : new Error("界面脚本加载失败"));
}

export function initializeStartup() {
  initializeContextMenu();
  try {
    // 桌面端在官方 API 初始化后读取主题；此处只为浏览器预览预着色。
    const saved =
      "NL_PORT" in window
        ? null
        : (JSON.parse(localStorage.getItem("javm-ui-preferences-v1") ?? "null")?.colorScheme ??
          localStorage.getItem("javm:color-scheme"));
    document.documentElement.dataset.mantineColorScheme =
      saved === "light" || (saved === "auto" && matchMedia("(prefers-color-scheme: light)").matches)
        ? "light"
        : "dark";
  } catch {
    // 存储不可用时，保持与 MantineProvider 相同的默认深色。
  }
  retry?.addEventListener("click", () => {
    void import("../platform/neutralino/feedback")
      .then(async ({ prepareFeedbackExit }) => {
        await prepareFeedbackExit();
        location.reload();
      })
      .catch(() => location.reload());
  });
  feedback?.addEventListener("click", () => {
    feedback.disabled = true;
    void import("../platform/neutralino/feedback")
      .then(async ({ createApplicationFeedback }) => {
        const service = createApplicationFeedback("NL_PORT" in window ? "desktop" : "browser");
        if (!service) throw new Error("启动诊断仅在桌面端可用。");
        const id = service.capture({
          module: "app",
          title: "应用启动失败",
          message:
            startupError instanceof Error
              ? (startupError.stack ?? startupError.message)
              : "界面加载失败",
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const message = await service.submit(id);
        if (status) status.textContent = message;
      })
      .catch(() => {
        if (status) status.textContent = "反馈信息未能复制，请重新加载，或保留应用日志手动反馈。";
      })
      .finally(() => {
        feedback.disabled = false;
      });
  });
  window.addEventListener("error", moduleError, true);
  slowTimer = setTimeout(() => {
    if (status) status.textContent = "启动耗时较长，仍在加载界面…";
    if (retry) retry.hidden = false;
  }, 8000);
}

export function finishStartup() {
  if (completed) return false;
  completed = true;
  clearTimeout(slowTimer);
  window.removeEventListener("error", moduleError, true);
  if (splash) splash.hidden = true;
  return true;
}

export function failStartup(error: unknown) {
  startupError = error;
  clearTimeout(slowTimer);
  window.removeEventListener("error", moduleError, true);
  if (splash) splash.hidden = false;
  if (status) status.textContent = "界面加载失败，请重试。";
  if (retry) retry.hidden = false;
  if (feedback) feedback.hidden = false;
  logEvent(
    "error",
    "app",
    "startup_failed",
    error instanceof Error ? error.message : "应用启动失败",
  );
}
