import "@mantine/core/styles.css";
import "../styles/global.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { localStorageColorSchemeManager, MantineProvider } from "@mantine/core";
import { cssVariablesResolver, theme } from "./theme";
import { initializePlatform } from "../platform/neutralino/bootstrap";
import { playerWindowId } from "../services/playback/windowChannel";
import { createApplicationLogs } from "../platform/neutralino/logging";
import { logEvent } from "../services/logging/events";
import { failStartup, finishStartup } from "./startup";

let frontendLoadedAt = 0;
let viewLoadedAt = 0;

function StartupReady() {
  useEffect(() => {
    if (!finishStartup()) return;
    logEvent("info", "app", "ui_ready", "界面已挂载", {
      frontendLoadMs: Math.round(frontendLoadedAt),
      viewLoadMs: Math.round(viewLoadedAt - frontendLoadedAt),
      renderMs: Math.round(performance.now() - viewLoadedAt),
      totalMs: Math.round(performance.now()),
    });
  }, []);
  return null;
}

export async function start() {
  // 宿主初始化属于应用生命周期，不放进 React 组件的 effect。
  const runtime = initializePlatform();
  document.documentElement.dataset.runtime = runtime;
  const root = document.getElementById("root");
  if (!root) throw new Error("缺少应用根节点");
  const id = runtime === "desktop" ? playerWindowId() : undefined;
  if (!id) createApplicationLogs(runtime);
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
        colorSchemeManager={localStorageColorSchemeManager({ key: "javm:color-scheme" })}
      >
        {view}
        <StartupReady />
      </MantineProvider>
    </StrictMode>,
  );
}
