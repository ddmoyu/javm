import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { app, filesystem, os, server, window as nativeWindow } from "@neutralinojs/lib";
import { initializePlatform } from "../../../frontend/src/platform/neutralino/bootstrap";
import { createPlaybackService, play } from "../../../frontend/src/platform/neutralino/playback";
import { createPlaybackSettings } from "../../../frontend/src/platform/neutralino/playbackSettings";
import { createPlaybackHistory } from "../../../frontend/src/platform/neutralino/playbackHistory";
import { playbackRequest } from "../../../frontend/src/services/playback/source";
import { createPlayerView } from "../../../frontend/src/features/player/PlayerApp";
import { playerWindowId } from "../../../frontend/src/services/playback/windowChannel";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";
import { createApplicationLogs } from "../../../frontend/src/platform/neutralino/logging";

const runtime = initializePlatform();
document.documentElement.dataset.runtime = runtime;
const id = playerWindowId();
const logs = id ? undefined : createApplicationLogs(runtime);
const channel = new BroadcastChannel("javm:player-window-test");
const service = createPlaybackService(runtime);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, label: string, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(100);
  }
}
const exceptions: string[] = [];
window.addEventListener("error", (event) => exceptions.push(event.message));
window.addEventListener("unhandledrejection", (event) => exceptions.push(String(event.reason)));
if (id) {
  new MutationObserver(() => {
    const video = document.querySelector("video");
    if (video) video.muted = true;
  }).observe(document.body, { childList: true, subtree: true });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        {createPlayerView(id, runtime)}
      </MantineProvider>
    </StrictMode>,
  );
  channel.onmessage = ({ data }) => {
    if (!data.action || (data.target && data.target !== id)) return;
    const execute = async () => {
      if (data.action === "inspect") {
        const video = document.querySelector("video");
        const element = document.querySelector<HTMLElement>(".playback-window")!;
        const rect = element.getBoundingClientRect();
        return {
          windowId: id,
          pid: window.NL_PID,
          source: service.getSnapshot().request?.source,
          time: video?.currentTime,
          paused: video?.paused,
          revision: service.getSnapshot().revision,
          focused: document.hasFocus(),
          progress: !!service.getSnapshot().media?.progress,
          native: element.hasAttribute("data-native"),
          fillsWindow:
            rect.width === innerWidth &&
            rect.height === innerHeight &&
            rect.left === 0 &&
            rect.top === 0,
          maximized: await nativeWindow.isMaximized(),
          minimized: await nativeWindow.isMinimized(),
          size: await nativeWindow.getSize(),
          position: await nativeWindow.getPosition(),
          config: await app.getConfig(),
          playing:
            element.dataset.revision === String(service.getSnapshot().revision) &&
            !service.getSnapshot().preparing &&
            !!video &&
            !video.paused &&
            video.currentTime > 0.25 &&
            video.videoWidth > 0,
          mounts: await server.getMounts(),
          processes: await os.getSpawnedProcesses(),
          title: document.querySelector(".playback-drag")?.textContent,
          exceptions,
        };
      }
      if (data.action === "seek") {
        const video = document.querySelector("video");
        if (!video) throw new Error("缺少媒体元素");
        video.pause();
        video.currentTime = data.time;
        await until(() => !video.seeking, "定位完成");
        await service.getSnapshot().media?.progress?.flush();
        return true;
      }
      if (data.action === "snapshot") {
        await nativeWindow.snapshot(data.path);
        return true;
      }
      if (data.action === "doubleClickTitle") {
        document
          .querySelector(".playback-drag")
          ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        return true;
      }
      if (data.action === "resize") {
        await nativeWindow.setSize({ width: 800, height: 500 });
        return true;
      }
      const button = document.querySelector<HTMLButtonElement>(
        `button[aria-label="${data.label}"]`,
      );
      if (!button) throw new Error(`找不到按钮 ${data.label}`);
      button.click();
      return true;
    };
    void execute()
      .then((result) => channel.postMessage({ id: data.id, result }))
      .catch((error: unknown) => channel.postMessage({ id: data.id, error: String(error) }));
  };
  channel.postMessage({ type: "joined", windowId: id });
} else {
  document.getElementById("root")!.textContent = "独立播放器窗口验证 · 主窗口保持运行";
  const params = new URLSearchParams(location.search);
  const resultPath = params.get("result")!;
  const source = params.get("source")!;
  const endpoint = params.get("endpoint")!;
  const results: { name: string; ok: boolean; elapsedMs: number; detail?: unknown }[] = [];
  const requests = new Map<
    string,
    { resolve: (data: any) => void; reject: (error: Error) => void }
  >();
  const windows: string[] = [];
  channel.onmessage = ({ data }) => {
    if (data.type === "joined") {
      windows.push(data.windowId);
      return;
    }
    const pending = requests.get(data.id);
    if (pending) {
      requests.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    }
  };
  const ask = (action: string, detail: Record<string, unknown> = {}): Promise<any> => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error(`子窗口未响应：${action}`));
      }, 10000);
      requests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      channel.postMessage({ id: requestId, action, target: windows.at(-1), ...detail });
    });
  };
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const record = async (name: string, run: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      const detail = await run();
      results.push({ name, ok: true, elapsedMs: Math.round(performance.now() - started), detail });
    } catch (error) {
      results.push({
        name,
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        detail: String(error),
      });
      throw error;
    }
    await filesystem.writeFile(resultPath, JSON.stringify({ done: false, results, exceptions }));
  };
  const run = async () => {
    let pid: number;
    let firstWindow: string;
    let secondWindow: string;
    const settings = createPlaybackSettings(runtime);
    await record("函数入口创建独立无边框窗口并播放本地视频", async () => {
      await play(`${source}/测试 & 100% #1.mp4`, { title: "自绘标题栏 · 本地视频" });
      await until(async () => (await ask("inspect")).playing, "首帧");
      const state = await ask("inspect");
      pid = Number(state.pid);
      check(pid !== Number(window.NL_PID), "必须是独立宿主进程");
      check(state.native && state.fillsWindow, "播放器必须填满子窗口");
      check(state.config.enableExtensions === false, "子窗口不能启动数据库扩展");
      check(state.config.modes.window.borderless === true, "子窗口必须无系统边框");
      check(!state.exceptions.length, `子窗口异常：${state.exceptions}`);
      await ask("snapshot", { path: resultPath.replace("result.json", "player-window.png") });
      return { pid, size: state.size, config: state.config.modes.window, parentPid: window.NL_PID };
    });
    await record("自绘最大化按钮与标题栏双击还原", async () => {
      await ask("click", { label: "最大化播放器" });
      await until(async () => (await ask("inspect")).maximized, "最大化");
      await ask("doubleClickTitle");
      await until(async () => !(await ask("inspect")).maximized, "双击还原");
      check(!(await nativeWindow.isMaximized()), "播放器操作影响了主窗口");
    });
    await record("调整窗口大小仍填满客户区", async () => {
      await ask("resize");
      await until(async () => {
        const state = await ask("inspect");
        return state.fillsWindow && state.size.width === 800;
      }, "缩放布局");
    });
    await record("独立最小化及传入网络视频后恢复同一窗口", async () => {
      await ask("click", { label: "最小化播放器" });
      await until(async () => (await ask("inspect")).minimized, "最小化");
      check(!(await nativeWindow.isMinimized()), "主窗口不应最小化");
      await play(`${endpoint}/cors/playlist.m3u8`, { title: "自绘标题栏 · 网络视频" });
      await until(async () => {
        const state = await ask("inspect");
        return state.playing && !state.minimized;
      }, "复用和网络播放");
      const state = await ask("inspect");
      check(Number(state.pid) === pid, "换片应复用窗口");
      return { pid: state.pid, title: state.title };
    });
    await record("子窗口本地 HLS 与原生无 CORS 传输", async () => {
      await play(`${source}/playlist.m3u8`);
      await until(async () => (await ask("inspect")).playing, "本地 HLS");
      await play(`${endpoint}/native/playlist.m3u8`);
      await until(async () => (await ask("inspect")).playing, "无 CORS HLS");
    });
    await record("关闭子窗口后重新打开", async () => {
      await ask("click", { label: "关闭播放器" });
      await service.close();
      check(!service.getSnapshot().opened, "关闭状态未同步");
      await play(`${endpoint}/cors/fixture.mp4`);
      await until(async () => (await ask("inspect")).playing, "再次打开");
      const state = await ask("inspect");
      check(Number(state.pid) !== pid, "关闭后应创建新窗口");
      return { previousPid: pid, reopenedPid: state.pid };
    });
    await record("新窗口模式同时播放本地和网络视频，两个独立进程互不替换", async () => {
      await service.close();
      await settings.update({
        ...settings.getSnapshot().settings,
        windowMode: "new",
      });
      await play(`${source}/测试 & 100% #1.mp4`, { title: "多窗口 · 本地" });
      await until(async () => (await ask("inspect")).playing, "本地新窗口");
      const first = await ask("inspect");
      firstWindow = first.windowId;
      await play(`${endpoint}/cors/fixture.mp4`, { title: "多窗口 · 网络" });
      await until(async () => (await ask("inspect")).playing, "网络新窗口");
      const second = await ask("inspect");
      secondWindow = second.windowId;
      const previous = await ask("inspect", { target: firstWindow });
      check(first.pid !== second.pid && firstWindow !== secondWindow, "必须创建两个独立窗口");
      check(previous.playing && previous.source === first.source, "旧窗口被替换或停止");
      check(first.progress && second.progress, "两个窗口必须启用进度记忆");
      check(!previous.exceptions.length && !second.exceptions.length, "子窗口出现异常");
      return {
        localPid: first.pid,
        networkPid: second.pid,
        local: previous.source,
        network: second.source,
      };
    });
    await record("两个窗口并发保存进度，记录均能恢复", async () => {
      await Promise.all([
        ask("seek", { target: firstWindow, time: 7 }),
        ask("seek", { target: secondWindow, time: 10 }),
      ]);
      const history = createPlaybackHistory();
      const local = await history.session(playbackRequest(`${source}/测试 & 100% #1.mp4`));
      const network = await history.session(playbackRequest(`${endpoint}/cors/fixture.mp4`));
      check(Math.abs(local.resumeAt - 7) < 0.5, `本地进度丢失：${local.resumeAt}`);
      check(Math.abs(network.resumeAt - 10) < 0.5, `网络进度丢失：${network.resumeAt}`);
      return { local: local.resumeAt, network: network.resumeAt };
    });
    await record("重复点击本地或网络视频只恢复已有窗口，保留进度和暂停状态", async () => {
      const count = windows.length;
      const first = await ask("inspect", { target: firstWindow });
      const second = await ask("inspect", { target: secondWindow });
      await ask("click", { target: firstWindow, label: "最小化播放器" });
      await until(
        async () => (await ask("inspect", { target: firstWindow })).minimized,
        "本地窗口最小化",
      );
      await play(`${source}/测试 & 100% #1.mp4`.toUpperCase().replaceAll("/", "\\"), {
        title: "另一入口传来的标题",
      });
      await until(async () => {
        const state = await ask("inspect", { target: firstWindow });
        return !state.minimized && state.focused;
      }, "重复本地视频恢复与激活");
      const local = await ask("inspect", { target: firstWindow });
      await ask("click", { target: secondWindow, label: "最小化播放器" });
      await until(
        async () => (await ask("inspect", { target: secondWindow })).minimized,
        "网络窗口最小化",
      );
      await play(`${endpoint}/cors/fixture.mp4`);
      await until(async () => {
        const state = await ask("inspect", { target: secondWindow });
        return !state.minimized && state.focused;
      }, "重复网络视频恢复与激活");
      const network = await ask("inspect", { target: secondWindow });
      check(windows.length === count, "重复视频创建了额外窗口");
      check(
        local.pid === first.pid &&
          local.revision === first.revision &&
          local.paused &&
          Math.abs(local.time - 7) < 0.5,
        "本地视频被重新加载或暂停位置改变",
      );
      check(
        network.pid === second.pid &&
          network.revision === second.revision &&
          network.paused &&
          Math.abs(network.time - 10) < 0.5,
        "网络视频被重新加载或暂停位置改变",
      );
      // 复用模式也必须优先找到原窗口，不能把最近窗口替换成已打开的视频。
      await settings.update({ ...settings.getSnapshot().settings, windowMode: "reuse" });
      await play(`${source}/测试 & 100% #1.mp4`);
      const unchanged = await ask("inspect", { target: secondWindow });
      check(
        windows.length === count &&
          unchanged.source === second.source &&
          unchanged.revision === second.revision,
        "复用模式替换了另一个窗口",
      );
      return {
        localPid: local.pid,
        networkPid: network.pid,
        localTime: local.time,
        networkTime: network.time,
        windowsCreated: windows.length - count,
      };
    });
    await record("切换为复用仅替换最近窗口，独立关闭后回退到仍打开的窗口", async () => {
      const first = await ask("inspect", { target: firstWindow });
      const second = await ask("inspect", { target: secondWindow });
      await settings.update({ ...settings.getSnapshot().settings, windowMode: "reuse" });
      await play(`${endpoint}/cors/playlist.m3u8`);
      await until(
        async () => (await ask("inspect", { target: secondWindow })).playing,
        "最近窗口换片",
      );
      const reused = await ask("inspect", { target: secondWindow });
      const unchanged = await ask("inspect", { target: firstWindow });
      check(
        second.pid === reused.pid && reused.source.endsWith("playlist.m3u8"),
        "没有复用最近窗口",
      );
      check(
        unchanged.source === first.source && Math.abs(unchanged.time - 7) < 0.5,
        "影响了另一个窗口",
      );
      await ask("click", { target: secondWindow, label: "关闭播放器" });
      await until(
        () => service.getSnapshot().request?.source === first.source,
        "回退到仍打开的窗口",
      );
      check(service.getSnapshot().opened, "关闭一个窗口不应清空全部播放状态");
      await play(`${endpoint}/cors/playlist.m3u8`);
      await until(
        async () => (await ask("inspect", { target: firstWindow })).playing,
        "复用剩余窗口",
      );
      check((await ask("inspect", { target: firstWindow })).pid === first.pid, "没有复用剩余窗口");
      return { reusedPid: reused.pid, remainingPid: first.pid };
    });
    await record("主程序退出前清理慢请求及关闭播放器", async () => {
      // 保留正在播放的第一个窗口，再创建一个带慢请求的窗口。
      await settings.update({ ...settings.getSnapshot().settings, windowMode: "new" });
      const start = performance.now();
      await play(`${endpoint}/native/slow.m3u8`, { referer: `${endpoint}/watch/clip` });
      const prepared = performance.now();
      await until(async () => (await ask("inspect")).processes.length > 0, "原生慢请求");
      const closing = performance.now();
      const childPids = [
        (await ask("inspect", { target: firstWindow })).pid,
        (await ask("inspect")).pid,
      ];
      if (params.get("hold") === "1") await service.close();
      else await service.shutdown();
      check(!service.getSnapshot().opened, "退出时播放器未关闭");
      check(performance.now() - closing < 10000, "关闭等待了网络超时，取消未及时生效");
      return {
        prepareMs: Math.round(prepared - start),
        waitForProcessMs: Math.round(closing - prepared),
        closeMs: Math.round(performance.now() - closing),
        closedPids: childPids,
      };
    });
    await record("播放器日志统一回传主窗口并落盘", async () => {
      const recent = await logs!.recent();
      check(!logs!.getSnapshot().error, "统一日志写入失败");
      check(
        recent.some((entry) => entry.module === "playback" && entry.context?.windowId),
        "缺少子窗口回传日志",
      );
      return { records: recent.length };
    });
    if (params.get("hold") === "1") {
      await play(`${source}/测试 & 100% #1.mp4`, { title: "窗口交互验证" });
      setInterval(() => {
        void ask("inspect")
          .then((state) =>
            filesystem.writeFile(
              resultPath.replace("result.json", "window-state.json"),
              JSON.stringify(state),
            ),
          )
          .catch(() => {});
      }, 1000);
    }
  };
  void run()
    .then(async () => {
      await filesystem.writeFile(resultPath, JSON.stringify({ done: true, results, exceptions }));
    })
    .catch(async (error: unknown) => {
      await service.close().catch(() => {});
      await filesystem.writeFile(
        resultPath,
        JSON.stringify({ done: true, results, exceptions, fatal: String(error) }),
      );
    });
}
