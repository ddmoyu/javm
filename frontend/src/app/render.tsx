import "@mantine/core/styles.css";
import "../styles/global.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { cssVariablesResolver, theme } from "./theme";
import { initializePlatform } from "../platform/neutralino/bootstrap";
import { playerWindowId } from "../services/playback/windowChannel";
import { createApplicationLogs } from "../platform/neutralino/logging";
import { logEvent } from "../services/logging/events";
import { failStartup, finishStartup } from "./startup";
import { confirmUpdateStartup, prepareUpdateStartup } from "../platform/neutralino/updateStartup";
import { createUiPreferences, uiColorSchemeManager } from "./preferences";
import type { UiPreferencesService } from "../services/settings/UiPreferencesService";
import { createApplicationFeedback } from "../platform/neutralino/feedback";
import { FeedbackBoundary } from "../features/feedback/FeedbackBoundary";
import { FeedbackDialog } from "../features/feedback/FeedbackDialog";

let frontendLoadedAt = 0;
let viewLoadedAt = 0;

function StartupReady({ preferences, main }: { preferences: UiPreferencesService; main: boolean }) {
  useEffect(() => {
    void confirmUpdateStartup()
      .then(() => {
        // 先完成更新试运行，再落盘迁移值；不能在界面挂载前等待写入门闩。
        if (main) return preferences.flush();
      })
      .catch(failStartup);
    if (!finishStartup()) return;
    logEvent("info", "app", "ui_ready", "界面已挂载", {
      frontendLoadMs: Math.round(frontendLoadedAt),
      viewLoadMs: Math.round(viewLoadedAt - frontendLoadedAt),
      renderMs: Math.round(performance.now() - viewLoadedAt),
      totalMs: Math.round(performance.now()),
    });
  }, [preferences, main]);
  return null;
}

export async function start() {
  // 宿主初始化属于应用生命周期，不放进 React 组件的 effect。
  const runtime = initializePlatform();
  document.documentElement.dataset.runtime = runtime;
  const root = document.getElementById("root");
  if (!root) throw new Error("缺少应用根节点");
  const id = runtime === "desktop" ? playerWindowId() : undefined;
  if (runtime === "desktop" && !id) {
    if ((await prepareUpdateStartup()) === false) return;
    const { claimApplicationInstance } = await import("../platform/neutralino/applicationInstance");
    if (!(await claimApplicationInstance())) return;
  }
  if (!id) createApplicationLogs(runtime);
  const feedback = !id ? createApplicationFeedback(runtime) : undefined;
  const preferences = createUiPreferences(runtime);
  await preferences.initialize();
  const scheme = preferences.getSnapshot().value.colorScheme;
  document.documentElement.dataset.mantineColorScheme =
    scheme === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : scheme;
  frontendLoadedAt = performance.now();
  logEvent("info", "app", "frontend_loaded", "前端基础模块已加载", {
    elapsedMs: Math.round(frontendLoadedAt),
  });
  const module = id ? await import("../features/player/PlayerApp") : await import("./mainView");
  viewLoadedAt = performance.now();
  const view =
    "createPlayerView" in module
      ? module.createPlayerView(id!, runtime)
      : module.createMainView(runtime);
  createRoot(root, { onUncaughtError: failStartup }).render(
    <StrictMode>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
        colorSchemeManager={uiColorSchemeManager(preferences)}
      >
        <FeedbackBoundary service={feedback}>
          {view}
          <StartupReady preferences={preferences} main={!id} />
        </FeedbackBoundary>
        {feedback && <FeedbackDialog service={feedback} />}
      </MantineProvider>
    </StrictMode>,
  );
}
