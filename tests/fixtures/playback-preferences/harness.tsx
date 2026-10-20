import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { filesystem, window as nativeWindow } from "@neutralinojs/lib";
import { initializePlatform } from "../../../frontend/src/platform/neutralino/bootstrap";
import { createPlaybackService } from "../../../frontend/src/platform/neutralino/playback";
import {
  createPlaybackSettings,
  playbackStorage,
} from "../../../frontend/src/platform/neutralino/playbackSettings";
import { createPlayerView } from "../../../frontend/src/features/player/PlayerApp";
import { playerWindowId } from "../../../frontend/src/services/playback/windowChannel";
import { playbackRequest, playbackSourceKey } from "../../../frontend/src/services/playback/source";
import { PlaybackSettingsService } from "../../../frontend/src/services/playback/PlaybackSettingsService";
import { PlaybackSettingsPanel } from "../../../frontend/src/features/settings/PlaybackSettingsPanel";
import { WorkspaceContext } from "../../../frontend/src/app/state";
import type { WorkspaceState } from "../../../frontend/src/app/state";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";

const runtime = initializePlatform();
document.documentElement.dataset.runtime = runtime;
const id = playerWindowId();
const player = createPlaybackService(runtime);
const settings = createPlaybackSettings(runtime);
const channel = new BroadcastChannel("javm:playback-preferences-test");
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = performance.now() + 20000;
  while (!(await check())) {
    if (performance.now() > end) throw new Error(`等待超时：${label}`);
    await sleep(100);
  }
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      {id ? (
        createPlayerView(id, runtime)
      ) : (
        <WorkspaceContext.Provider
          value={{ playbackSettings: settings, notice: () => {} } as unknown as WorkspaceState}
        >
          <main style={{ maxWidth: 760, padding: 28, margin: "auto" }}>
            <PlaybackSettingsPanel />
          </main>
        </WorkspaceContext.Provider>
      )}
    </MantineProvider>
  </StrictMode>,
);
if (id) {
  new MutationObserver(() => {
    const video = document.querySelector("video");
    if (video) video.muted = true;
  }).observe(document.body, { childList: true, subtree: true });
  channel.onmessage = ({ data }) => {
    const execute = async () => {
      const video = document.querySelector("video");
      if (data.action === "seek") {
        if (!video) throw new Error("缺少媒体元素");
        video.pause();
        video.currentTime = data.time;
        await until(() => !video.seeking, "定位完成");
      }
      return {
        pid: window.NL_PID,
        time: video?.currentTime,
        playing: !!video && video.videoWidth > 0 && video.currentTime > 0.2,
        progress: !!player.getSnapshot().media?.progress,
        revision: document.querySelector<HTMLElement>(".playback-window")?.dataset.revision,
        expectedRevision: player.getSnapshot().revision,
        errors,
      };
    };
    void execute()
      .then((result) => channel.postMessage({ id: data.id, result }))
      .catch((error: unknown) => channel.postMessage({ id: data.id, error: String(error) }));
  };
} else {
  const params = new URLSearchParams(location.search);
  const resultPath = params.get("result")!;
  const source = `${params.get("source")}/测试 & 100% #1.mp4`;
  const endpoint = params.get("endpoint")!;
  const externalPlayer = params.get("externalPlayer")!;
  const received = externalPlayer.replace(/[^\\/]+$/, "received.txt");
  const results: { name: string; ok: boolean; detail?: unknown }[] = [];
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  channel.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  const ask = (action = "inspect", extra = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("播放器未响应"));
      }, 10000);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      channel.postMessage({ id: requestId, action, ...extra });
    });
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const playing = async () => {
    const value = await ask();
    return value.playing && value.revision === String(value.expectedRevision);
  };
  const record = async (name: string, run: () => Promise<unknown>) => {
    try {
      results.push({ name, ok: true, detail: await run() });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error) });
      throw error;
    }
    await filesystem.writeFile(
      resultPath,
      JSON.stringify({ done: false, results, exceptions: errors }),
    );
  };
  const run = async () => {
    await record("界面保存窗口模式，重读持久化设置并切回复用", async () => {
      await settings.initialize();
      await until(
        () => !!document.querySelector('input[aria-label="播放窗口模式"]'),
        "窗口模式设置",
      );
      for (const [label, mode] of [
        ["在新窗口中播放", "new"],
        ["复用现有窗口", "reuse"],
      ]) {
        document.querySelector<HTMLInputElement>('input[aria-label="播放窗口模式"]')!.click();
        await until(
          () =>
            [...document.querySelectorAll('[role="option"]')].some(
              (option) => option.textContent === label,
            ),
          "窗口模式选项",
        );
        [...document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((option) => option.textContent === label)!
          .click();
        await until(
          () =>
            [...document.querySelectorAll("button")].some(
              (button) => button.textContent === "保存播放设置" && !button.disabled,
            ),
          "模式保存按钮",
        );
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === "保存播放设置")!
          .click();
        await until(() => settings.getSnapshot().settings.windowMode === mode, "窗口模式写入");
        const restarted = new PlaybackSettingsService(playbackStorage("javm-playback-settings-v1"));
        await restarted.initialize();
        check(restarted.getSnapshot().settings.windowMode === mode, "窗口模式未持久化");
      }
    });
    await record("移除进度开关，兼容旧关闭设置与已有进度", async () => {
      check(!document.querySelector('input[aria-label="记住播放进度"]'), "进度开关仍存在");
      const stored = playbackStorage("javm-playback-settings-v1");
      await stored.write({ ...settings.getSnapshot().settings, rememberProgress: false });
      await settings.reload();
      check(!("rememberProgress" in settings.getSnapshot().settings), "旧开关仍在生效");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(playbackSourceKey(playbackRequest(source))),
      );
      const key = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      await playbackStorage("javm-playback-history-v1").write([
        { key, time: 6, duration: 20, updated: Date.now() },
      ]);
      await nativeWindow.snapshot(resultPath.replace("result.json", "playback-settings.png"));
    });
    await record("关闭独立播放器后重开恢复本地进度", async () => {
      await player.play(source);
      await until(playing, "本地首帧");
      const first = await ask();
      check(first.progress && first.time >= 6 && first.time < 9, "旧版进度没有自动迁移恢复");
      await ask("seek", { time: 8 });
      await player.close();
      await player.play(source);
      await until(playing, "恢复进度");
      const next = await ask();
      check(first.pid !== next.pid, "没有重新创建独立播放器进程");
      check(next.progress && next.time >= 8 && next.time < 11, `未恢复：${next.time}`);
      return { oldPid: first.pid, newPid: next.pid, time: next.time };
    });
    await record("同一窗口换片后自动恢复原视频进度", async () => {
      await player.play(`${endpoint}/cors/fixture.mp4`);
      await until(playing, "切换视频");
      await player.play(source);
      await until(playing, "返回原视频");
      check((await ask()).time >= 8, "未自动使用已保存的位置");
    });
    await record("片尾位置清除，下次从头播放", async () => {
      await ask("seek", { time: 18 });
      await player.close();
      await player.play(source);
      await until(playing, "片尾后重开");
      check((await ask()).time < 4, "片尾位置未清除");
    });
    await record("网络 HLS 也能跨窗口恢复进度", async () => {
      await player.play(`${endpoint}/cors/playlist.m3u8`);
      await until(playing, "HLS 首帧");
      await ask("seek", { time: 8 });
      await player.close();
      await player.play(`${endpoint}/cors/playlist.m3u8`);
      await until(playing, "HLS 恢复");
      check((await ask()).time >= 8, "HLS 未恢复进度");
    });
    await record("外部播放器收到一个完整的中文及特殊字符文件参数", async () => {
      await settings.update({
        ...settings.getSnapshot().settings,
        defaultPlayer: "external",
        externalPlayerPath: externalPlayer,
      });
      await player.play(source);
      await until(async () => {
        try {
          return !!(await filesystem.getStats(received)).isFile;
        } catch {
          return false;
        }
      }, "外部程序参数文件");
      check(
        (await filesystem.readFile(received)).trim() === source.replaceAll("\\", "/"),
        "文件参数发生截断或转义错误",
      );
      check(!player.getSnapshot().opened, "外部交接后内置播放器未关闭");
    });
    await record("外部播放器原样接收含多个查询参数的网络地址", async () => {
      await filesystem.remove(received);
      const url = `${endpoint}/cors/fixture.mp4?x=a%22b&y=%25+z&literal=%24(test)`;
      await player.play(url);
      await until(async () => {
        try {
          return !!(await filesystem.getStats(received)).isFile;
        } catch {
          return false;
        }
      }, "网络参数文件");
      check((await filesystem.readFile(received)).trim() === url, "网络地址被作为 shell 语法处理");
    });
    await record("已保存播放器被移走时报告失败", async () => {
      await filesystem.move(externalPlayer, `${externalPlayer}.held`);
      try {
        let error = "";
        try {
          await player.play(source);
        } catch (reason) {
          error = String(reason);
        }
        check(error.includes("不存在"), "未报告播放器缺失");
      } finally {
        await filesystem.move(`${externalPlayer}.held`, externalPlayer);
      }
    });
    await player.shutdown();
    await filesystem.writeFile(
      resultPath,
      JSON.stringify({ done: true, results, exceptions: errors }),
    );
  };
  void run().catch(async (error: unknown) => {
    await player.close().catch(() => {});
    await filesystem.writeFile(
      resultPath,
      JSON.stringify({ done: true, results, exceptions: errors, fatal: String(error) }),
    );
  });
}
