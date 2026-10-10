import { logEvent } from "../services/logging/events";
import { initializeContextMenu } from "./contextMenu";

const splash = document.getElementById("startup");
const status = document.getElementById("startup-status");
const retry = document.getElementById("startup-retry");
let completed = false;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

function moduleError(event: Event) {
  if (event instanceof ErrorEvent || event.target instanceof HTMLScriptElement)
    failStartup(event instanceof ErrorEvent ? event.error : new Error("界面脚本加载失败"));
}

export function initializeStartup() {
  initializeContextMenu();
  try {
    const saved = localStorage.getItem("javm:color-scheme");
    document.documentElement.dataset.mantineColorScheme =
      saved === "light" || (saved === "auto" && matchMedia("(prefers-color-scheme: light)").matches)
        ? "light"
        : "dark";
  } catch {
    // 存储不可用时，保持与 MantineProvider 相同的默认深色。
  }
  retry?.addEventListener("click", () => location.reload());
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
  clearTimeout(slowTimer);
  window.removeEventListener("error", moduleError, true);
  if (splash) splash.hidden = false;
  if (status) status.textContent = "界面加载失败，请重试。";
  if (retry) retry.hidden = false;
  logEvent(
    "error",
    "app",
    "startup_failed",
    error instanceof Error ? error.message : "应用启动失败",
  );
}
