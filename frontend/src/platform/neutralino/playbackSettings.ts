import { filesystem, os } from "@neutralinojs/lib";
import {
  PlaybackSettingsService,
  validatePlaybackSettings,
} from "../../services/playback/PlaybackSettingsService";
import type { PlaybackRequest } from "../../services/playback/source";
import type { Runtime } from "./bootstrap";
import { encodedPowerShell, quoteWindowsArgument } from "./process";
import { nativeSettingsStorage as playbackStorage } from "./settingsStorage";

export { playbackStorage };

async function validatePlayerPath(path: string) {
  const stat = await filesystem.getStats(path).catch(() => null);
  if (!stat?.isFile) throw new Error("外部播放器不存在或无法读取，请重新选择 .exe 文件。");
}

let settings: PlaybackSettingsService | undefined;
export function createPlaybackSettings(runtime: Runtime) {
  settings ??= new PlaybackSettingsService(
    playbackStorage("javm-playback-settings-v1"),
    runtime === "desktop",
    async () =>
      (
        await os.showOpenDialog("选择外部播放器", {
          filters: [{ name: "Windows 播放器", extensions: ["exe"] }],
          multiSelections: false,
        })
      )[0],
    validatePlayerPath,
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
  if (runtime !== "desktop") throw new Error("外部播放需要在桌面应用中使用。");
  if (request.kind === "local") {
    const stat = await filesystem.getStats(request.source).catch(() => null);
    if (!stat?.isFile) throw new Error("视频文件不存在或无法读取，请检查路径及磁盘连接。");
  }
  signal?.throwIfAborted();
  if (!path) {
    await os.open(request.source);
    return;
  }
  validatePlaybackSettings({
    defaultPlayer: "external",
    externalPlayerPath: path,
  });
  await validatePlayerPath(path);
  signal?.throwIfAborted();
  const result = await os.execCommand(externalPlayerCommand(path, request.source));
  if (result.exitCode !== 0) throw new Error("无法启动外部播放器，请检查所选程序是否可运行。");
}
