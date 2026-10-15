import { init } from "@neutralinojs/lib";
import { initializeWindowFrame } from "./windowFrame";

export type Runtime = "browser" | "desktop";
let initialized = false;

export function initializePlatform(): Runtime {
  // 浏览器预览没有宿主注入的全局变量，不尝试连接原生 API。
  if (!("NL_PORT" in window)) return "browser";
  if (!initialized) {
    init();
    initializeWindowFrame();
    initialized = true;
  }
  return "desktop";
}
