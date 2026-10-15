import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { filesystem, os } from "@neutralinojs/lib";
import { openExternalPlayer } from "../frontend/src/platform/neutralino/playbackSettings";
import {
  PlaybackSettingsService,
  defaultPlaybackSettings,
  validatePlaybackSettings,
} from "../frontend/src/services/playback/PlaybackSettingsService";
import { playbackRequest } from "../frontend/src/services/playback/source";

vi.mock("@neutralinojs/lib", () => ({
  filesystem: { getStats: vi.fn(), access: vi.fn() },
  os: { execCommand: vi.fn(), open: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { NL_OS: "Linux" });
  vi.mocked(filesystem.getStats).mockResolvedValue({ isFile: true } as Awaited<
    ReturnType<typeof filesystem.getStats>
  >);
  vi.mocked(filesystem.access).mockResolvedValue("");
  vi.mocked(os.execCommand).mockResolvedValue({ exitCode: 0, stdOut: "", stdErr: "", pid: 100 });
});
afterEach(() => vi.unstubAllGlobals());

it.each(["Linux", "Darwin"] as const)("%s 允许原生播放器路径并能重新读取设置", async (platform) => {
  const value = { ...defaultPlaybackSettings, externalPlayerPath: "/Applications/安全播放器.app" };
  const service = new PlaybackSettingsService(
    { read: async () => value, write: vi.fn() },
    true,
    undefined,
    undefined,
    platform,
  );
  await service.initialize();
  expect(service.getSnapshot().settings.externalPlayerPath).toBe(value.externalPlayerPath);
  expect(service.getSnapshot().error).toBe("");
  expect(() => validatePlaybackSettings(value)).toThrow(".exe");
  expect(() =>
    validatePlaybackSettings({ ...value, externalPlayerPath: "/safe/../bin/player" }, platform),
  ).toThrow("绝对路径");
});
it("POSIX 播放器和媒体参数逐个转义，避免特殊字符成为 shell 命令", async () => {
  await openExternalPlayer(
    "desktop",
    playbackRequest("/Safe/$(touch marker)'风景.mp4"),
    "/Safe/player's tool",
  );
  expect(filesystem.access).toHaveBeenCalledWith("/Safe/player's tool", 1);
  expect(os.execCommand).toHaveBeenCalledWith(
    "'/Safe/player'\\''s tool' '/Safe/$(touch marker)'\\''风景.mp4'",
    { background: true },
  );
});
it("macOS APP 通过 LaunchServices 打开，启动失败不会报成功", async () => {
  vi.stubGlobal("window", { NL_OS: "Darwin" });
  vi.mocked(filesystem.getStats).mockImplementation(
    async (path) =>
      ({ isDirectory: path.endsWith(".app"), isFile: !path.endsWith(".app") }) as Awaited<
        ReturnType<typeof filesystem.getStats>
      >,
  );
  await openExternalPlayer(
    "desktop",
    playbackRequest("/Safe/山林.mp4"),
    "/Applications/Safe Player.app",
  );
  expect(os.execCommand).toHaveBeenCalledWith(
    "/usr/bin/open -a '/Applications/Safe Player.app' -- '/Safe/山林.mp4'",
    { background: false },
  );
  vi.mocked(os.execCommand).mockResolvedValue({ exitCode: 1, stdOut: "", stdErr: "", pid: 100 });
  await expect(
    openExternalPlayer(
      "desktop",
      playbackRequest("/Safe/山林.mp4"),
      "/Applications/Safe Player.app",
    ),
  ).rejects.toThrow("无法启动");
});
it("无执行权限的播放器不会被启动", async () => {
  vi.mocked(filesystem.access).mockRejectedValue({ code: "NE_FS_ACSFAIL" });
  await expect(
    openExternalPlayer("desktop", playbackRequest("/Safe/山林.mp4"), "/usr/bin/safe-player"),
  ).rejects.toThrow("执行权限");
  expect(os.execCommand).not.toHaveBeenCalled();
});
