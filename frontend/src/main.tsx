import { initializeStartup, failStartup } from "./app/startup";
import { installAbortCompatibility } from "./platform/abortCompatibility";

// 保持入口轻量，让启动提示先绘制，再加载 React、Mantine 和业务模块。
installAbortCompatibility();
initializeStartup();
void import("./app/render").then((module) => module.start()).catch(failStartup);
