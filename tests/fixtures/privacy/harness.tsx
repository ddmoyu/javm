import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Group, MantineProvider, Modal, Stack, Text, Title } from "@mantine/core";
import { app, events, filesystem, window as nativeWindow } from "@neutralinojs/lib";
import { initializePlatform } from "../../../frontend/src/platform/neutralino/bootstrap";
import {
  createPrivacyService,
  restorePrivateWindow,
} from "../../../frontend/src/platform/neutralino/privacy";
import { PrivacyBoundary } from "../../../frontend/src/features/privacy/PrivacyBoundary";
import { PrivacySettingsPanel } from "../../../frontend/src/features/settings/PrivacySettingsPanel";
import { WorkspaceContext } from "../../../frontend/src/app/state";
import type { WorkspaceState } from "../../../frontend/src/app/state";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";
import {
  initializePrivacyInput,
  setPrivacySession,
  getPrivacySession,
} from "../../../frontend/src/services/privacy/session";
import { createPlaybackService } from "../../../frontend/src/platform/neutralino/playback";
import { createPlayerView } from "../../../frontend/src/features/player/PlayerApp";
import { playerWindowId } from "../../../frontend/src/services/playback/windowChannel";
import {
  showOpenDialog,
  showFolderDialog,
} from "../../../frontend/src/platform/neutralino/privateDialogs";
import { openExternalPlayer } from "../../../frontend/src/platform/neutralino/playbackSettings";
import { playbackRequest } from "../../../frontend/src/services/playback/source";
import { initializeLifecycle } from "../../../frontend/src/platform/neutralino/lifecycle";
import type { DownloadService } from "../../../frontend/src/services/downloads/DownloadService";
import type { BackgroundSettingsService } from "../../../frontend/src/services/settings/BackgroundSettingsService";
import type { PrivacySettings } from "../../../frontend/src/services/privacy/PrivacyService";
import "../../../frontend/src/features/privacy/privacy.css";

const runtime = initializePlatform();
document.documentElement.dataset.runtime = runtime;
const params = new URLSearchParams(location.search);
const neutral = params.has("neutral");
const id = playerWindowId();
const rootPath = window.NL_PATH.replaceAll("\\", "/");
const channel = new BroadcastChannel("javm:privacy-safe-verification");
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const render = (view: React.ReactNode) =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        {view}
      </MantineProvider>
    </StrictMode>,
  );
const read = async (name: string) => {
  try {
    return JSON.parse(await filesystem.readFile(`${rootPath}/${name}`));
  } catch {
    return null;
  }
};

if (neutral) {
  await nativeWindow.setTitle("隐私测试 · 独立安全窗口");
  render(
    <Stack p="xl">
      <Title order={2}>独立安全窗口</Title>
      <Text>仅用于验证 JAVM 失去焦点后，F1 不生效、F9 仍生效。无媒体或业务数据。</Text>
      <input aria-label="安全焦点输入" defaultValue="Safe fixture" />
    </Stack>,
  );
} else {
  setPrivacySession({ protected: true });
  initializePrivacyInput();
  const playback = createPlaybackService(runtime);
  if (id) {
    render(createPlayerView(id, runtime));
    const publish = async () => {
      const video = document.querySelector("video");
      if (video) video.volume = 0.03;
      channel.postMessage({
        type: "probe",
        id,
        pid: window.NL_PID,
        visible: await nativeWindow.isVisible(),
        focused: document.hasFocus(),
        protected: getPrivacySession().protected,
        media: video
          ? {
              paused: video.paused,
              muted: video.muted,
              time: video.currentTime,
              ready: video.readyState,
              width: video.videoWidth,
              autoplay: video.autoplay,
            }
          : null,
        errors,
      });
    };
    channel.onmessage = ({ data }) => {
      if (data.type !== "fixture-play") return;
      const video = document.querySelector("video");
      if (video && !getPrivacySession().protected) {
        video.muted = false;
        void video.play().catch((error: unknown) => errors.push(String(error)));
      }
    };
    const tick = async () => {
      await publish();
      setTimeout(() => void tick(), 250);
    };
    void tick();
  } else {
    const privacy = createPrivacyService(runtime);
    await privacy.initialize();
    initializeLifecycle(
      {
        shutdown: async () => {
          await playback.shutdown();
        },
      } as DownloadService,
      { shouldRunInBackground: async () => true } as BackgroundSettingsService,
    );
    const fixtures = (await read("fixture.json")) as {
      file: string;
      directory: string;
      external: string;
      extension: string;
    };
    if (
      !fixtures ||
      !fixtures.file.startsWith(rootPath) ||
      !fixtures.directory.startsWith(rootPath)
    )
      throw new Error("安全样例路径必须属于本次隔离目录");
    const children = new Map<string, unknown>();
    channel.onmessage = ({ data }) => {
      if (data.type === "probe") children.set(data.id, data);
    };
    let commandResult: { id: string; ok: boolean; result?: unknown; error?: string } | undefined;
    let lastId = (await read("command.json"))?.id;
    let stopped = false;
    const startVideo = () =>
      playback.play(fixtures.file, { title: "安全样例 · 彩色测试图与合成音", format: "video" });
    const chooseFile = () =>
      showOpenDialog("选择安全隐私样例", {
        defaultPath: fixtures.directory,
        filters: [{ name: "安全样例", extensions: [fixtures.extension] }],
        multiSelections: false,
      });
    const chooseDirectory = () =>
      showFolderDialog("选择安全样例目录", { defaultPath: fixtures.directory });
    const safeImage = (() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 160;
      const ctx = canvas.getContext("2d")!;
      for (let y = 0; y < 8; ++y)
        for (let x = 0; x < 16; ++x) {
          ctx.fillStyle = (x + y) % 2 ? "#18bca2" : "#f8f4db";
          ctx.fillRect(x * 20, y * 20, 20, 20);
        }
      ctx.fillStyle = "#102b4c";
      ctx.font = "bold 28px sans-serif";
      ctx.fillText("SAFE SAMPLE", 45, 90);
      return canvas.toDataURL();
    })();
    function SafeContent() {
      const [modal, setModal] = useState(false);
      const [message, setMessage] = useState("");
      const perform = (operation: Promise<unknown>) => {
        void operation
          .then(() => setMessage("操作完成"))
          .catch((error: unknown) => setMessage(String(error)));
      };
      return (
        <div style={{ height: "100%", overflow: "auto", padding: 24 }}>
          <Stack maw={1100} mx="auto" gap="md">
            <Title order={3}>JAVM 隐私保护 · 隔离安全样例</Title>
            <Text size="sm">只有程序生成的色块、合成音和临时配置，没有真实媒体库或在线内容。</Text>
            <Group>
              <Button onClick={() => perform(startVideo())}>播放安全视频</Button>
              <Button variant="default" onClick={() => perform(chooseFile())}>
                选择安全文件
              </Button>
              <Button variant="default" onClick={() => perform(chooseDirectory())}>
                选择安全目录
              </Button>
              <Button variant="default" onClick={() => setModal(true)}>
                打开安全弹框
              </Button>
            </Group>
            <Group>
              <div className="film-cover" style={{ width: 320, height: 160, flex: "none" }}>
                <img
                  id="safe-cover-a"
                  data-private-image
                  src={safeImage}
                  width={320}
                  height={160}
                  alt="安全色块 A"
                />
              </div>
              <img
                id="safe-cover-b"
                data-private-image
                src={safeImage}
                width={320}
                height={160}
                alt="安全色块 B"
              />
            </Group>
            <Text role="status">{message}</Text>
            <WorkspaceContext value={{ runtime } as WorkspaceState}>
              <PrivacySettingsPanel />
            </WorkspaceContext>
          </Stack>
          <Modal opened={modal} onClose={() => setModal(false)} title="安全弹框">
            <Text>测试 Esc 关闭弹框及 F1 隐藏整个应用。</Text>
            <input aria-label="安全弹框输入" defaultValue="Only safe fixture data" />
          </Modal>
        </div>
      );
    }
    render(
      <PrivacyBoundary service={privacy} runtime={runtime}>
        <SafeContent />
      </PrivacyBoundary>,
    );
    const execute = async (command: { id: string; action: string; value?: unknown }) => {
      let result: unknown;
      if (command.action === "restore") result = await restorePrivateWindow();
      else if (command.action === "play") result = await startVideo();
      else if (command.action === "play-again") channel.postMessage({ type: "fixture-play" });
      else if (command.action === "settings")
        result = await privacy.saveSettings({
          ...privacy.getSnapshot().settings,
          ...(command.value as Partial<PrivacySettings>),
        });
      else if (command.action === "password")
        result = await privacy.changePassword("", "Safe-Fixture-2026");
      else if (command.action === "lock") result = await privacy.conceal(true);
      else if (command.action === "unlock") result = await privacy.unlock(String(command.value));
      else if (command.action === "pick") result = await chooseFile();
      else if (command.action === "folder") result = await chooseDirectory();
      else if (command.action === "external")
        result = await openExternalPlayer(
          runtime,
          playbackRequest(fixtures.file, { format: "video" }),
          fixtures.external,
        );
      else if (command.action === "snapshot")
        result = await nativeWindow.snapshot(
          `${rootPath}/${String(command.value).replace(/[^\w-]/g, "")}.png`,
        );
      else if (command.action === "restart" || command.action === "exit") {
        stopped = true;
        await playback.shutdown();
        if (command.action === "restart")
          await filesystem.writeFile(
            `${rootPath}/restart.json`,
            JSON.stringify({ id: command.id }),
          );
        await app.exit();
      } else throw new Error("未知安全测试命令");
      return result;
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const command = await read("command.json");
        if (command?.id && command.id !== lastId) {
          lastId = command.id;
          void execute(command)
            .then((result) => {
              commandResult = { id: command.id, ok: true, result };
            })
            .catch((error: unknown) => {
              commandResult = { id: command.id, ok: false, error: String(error) };
            });
        }
        const content = document.querySelector(".privacy-content")!;
        const image = document.getElementById("safe-cover-a"),
          second = document.getElementById("safe-cover-b");
        await filesystem.writeFile(
          `${rootPath}/state.json`,
          JSON.stringify({
            pid: window.NL_PID,
            ready: true,
            visible: await nativeWindow.isVisible(),
            focused: document.hasFocus(),
            snapshot: privacy.getSnapshot(),
            session: getPrivacySession(),
            contentVisibility: content && getComputedStyle(content).visibility,
            lockVisible: !!document.querySelector("[data-privacy-lock]"),
            modalVisible: !!document.querySelector('[role="dialog"]'),
            blur: image && getComputedStyle(image).filter,
            secondBlur: second && getComputedStyle(second).filter,
            nativeBossEvents,
            children: [...children.values()],
            commandResult,
            errors,
          }),
        );
      } catch (error) {
        errors.push(String(error));
      }
      setTimeout(() => void tick(), 250);
    };
    let nativeBossEvents = 0;
    await events.on("javm.privacy.bossKey", () => {
      ++nativeBossEvents;
    });
    void tick();
  }
}
