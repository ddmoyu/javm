import { initializeStartup, failStartup } from "./app/startup";

// 保持入口轻量，让启动提示先绘制，再加载 React、Mantine 和业务模块。
initializeStartup();
void import("./app/render").then((module) => module.start()).catch(failStartup);
