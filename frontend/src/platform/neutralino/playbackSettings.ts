import { filesystem, os } from "@neutralinojs/lib";
import { t } from "../../i18n/core";
import {
  PlaybackSettingsService,
  validatePlaybackSettings,
} from "../../services/playback/PlaybackSettingsService";
import type { PlaybackRequest } from "../../services/playback/source";
import type { Runtime } from "./bootstrap";
import { encodedPowerShell, quoteWindowsArgument } from "./process";
import { nativeSettingsStorage as playbackStorage } from "./settingsStorage";
import { executableExists, toolPlatform } from "./toolPaths";
import { quotePosixArgument } from "./posixProcess";
import { showOpenDialog } from "./privateDialogs";
import { createPrivacyService } from "./privacy";
import { privacyNative } from "./privacyNative";
import { assertPlaybackAllowed, privacyRevision } from "../../services/privacy/session";

export { playbackStorage };

async function validatePlayerPath(path: string) {
  const stat = await filesystem.getStats(path).catch(() => null);
  if (toolPlatform() === "Darwin" && path.endsWith(".app") && stat?.isDirectory) return;
  if (!stat?.isFile || !(await executableExists(path)))
    throw new Error("外部播放器不存在、不可读取或没有执行权限，请重新选择。");
}

let settings: PlaybackSettingsService | undefined;
export function createPlaybackSettings(runtime: Runtime) {
  settings ??= new PlaybackSettingsService(
    playbackStorage("javm-playback-settings-v1"),
    runtime === "desktop",
    async () =>
      (
        await showOpenDialog(t("选择外部播放器"), {
          filters:
            toolPlatform() === "Windows"
              ? [{ name: t("Windows 播放器"), extensions: ["exe"] }]
              : toolPlatform() === "Darwin"
                ? [{ name: t("macOS 应用"), extensions: ["app", "*"] }]
                : undefined,
          multiSelections: false,
        })
      )[0],
    validatePlayerPath,
    runtime === "desktop" ? toolPlatform() : "Windows",
  );
  void settings.initialize();
  return settings;
}

export function externalPlayerCommand(path: string, source: string) {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // ShellExecute 只接收已验证的可执行文件和一个媒体参数；不等待或接管用户的播放器。
  const script = `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.ProcessStartInfo]::new(); $p.FileName=${literal(path)}; $p.Arguments=${literal(quoteWindowsArgument(source))}; $p.UseShellExecute=$true; [void][System.Diagnostics.Process]::Start($p);`;
  const command = encodedPowerShell(script);
  if (command.length > 8000)
    throw new Error("播放地址过长，无法传给外部播放器，请使用内置播放器。");
  return command;
}

export async function openExternalPlayer(
  runtime: Runtime,
  request: PlaybackRequest,
  path: string,
  signal?: AbortSignal,
) {
  assertPlaybackAllowed();
  const privacyVersion = privacyRevision();
  if (runtime !== "desktop") throw new Error("外部播放需要在桌面应用中使用。");
  if (request.kind === "local") {
    const stat = await filesystem.getStats(request.source).catch(() => null);
    if (!stat?.isFile) throw new Error("视频文件不存在或无法读取，请检查路径及磁盘连接。");
  }
  signal?.throwIfAborted();
  assertPlaybackAllowed(privacyVersion);
  if (
    toolPlatform() === "Windows" &&
    createPrivacyService(runtime).getSnapshot().settings.protectRecentFiles
  ) {
    if (path) await validatePlayerPath(path);
    signal?.throwIfAborted();
    assertPlaybackAllowed(privacyVersion);
    await privacyNative.request("privacy.openExternal", { source: request.source, path });
    return;
  }
  if (!path) {
    await os.open(request.source);
    return;
  }
  validatePlaybackSettings(
    {
      defaultPlayer: "external",
      externalPlayerPath: path,
    },
    toolPlatform(),
  );
  await validatePlayerPath(path);
  signal?.throwIfAborted();
  assertPlaybackAllowed(privacyVersion);
  const platform = toolPlatform();
  const macApp = platform === "Darwin" && path.endsWith(".app");
  const command =
    platform === "Windows"
      ? externalPlayerCommand(path, request.source)
      : macApp
        ? `/usr/bin/open -a ${quotePosixArgument(path)} -- ${quotePosixArgument(request.source)}`
        : `${quotePosixArgument(path)} ${quotePosixArgument(request.source)}`;
  // 外部播放器归用户所有。POSIX 普通可执行文件沿用官方后台启动，不纳入任务进程组。
  const result = await os.execCommand(command, { background: platform !== "Windows" && !macApp });
  if (result.exitCode !== 0) throw new Error("无法启动外部播放器，请检查所选程序是否可运行。");
}
