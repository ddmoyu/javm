import type { Runtime } from "./bootstrap";

export function desktopServicesAvailable(runtime: Runtime) {
  return runtime === "desktop" && ["Windows", "Darwin", "Linux"].includes(window.NL_OS);
}
