import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./components.mjs";
import { verifyFfmpegLite } from "../verify-ffmpeg-lite.mjs";
import { verifyMetatubeLite } from "../metatube-lite-profile.mjs";
import { verifyMediaInfoLite } from "../verify-mediainfo-lite.mjs";

export async function verifyRuntime(directory, manifest) {
  if (process.platform !== "win32" || manifest.platform !== "windows-x64") {
    throw new Error("当前仅提供 Windows x64 运行验证");
  }
  const runtime = path.join(directory, "runtime");
  for (const entry of manifest.files.filter((file) => /\.(exe|dll)$/i.test(file.path))) {
    const bytes = await readFile(path.join(directory, entry.path));
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("PE 文件头无效");
    const offset = bytes.readUInt32LE(0x3c);
    if (
      offset + 24 > bytes.length ||
      bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== 0x8664
    )
      throw new Error("组件必须是 Windows x64");
  }
  const sources = manifest.inputs.sources;
  if (manifest.component === "ffmpeg") await verifyFfmpegLite(runtime, sources.ffmpeg);
  if (manifest.component === "metatube") await verifyMetatubeLite(runtime, sources.metatube);
  if (manifest.component === "curl") {
    const version = execFileSync(path.join(runtime, "curl.exe"), ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    if (!version.includes("Unicode") || !version.includes("Schannel")) {
      throw new Error("curl 必须支持 Unicode 路径和 Schannel");
    }
  }
  if (manifest.component === "mediainfo") {
    await verifyMediaInfoLite(runtime, sources.mediainfo);
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const temporary = await mkdtemp(path.join(root, ".tmp/mediainfo-safe-"));
    const wave = Buffer.alloc(44 + 88200);
    wave.write("RIFF", 0);
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(44100, 24);
    wave.writeUInt32LE(88200, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write("data", 36);
    wave.writeUInt32LE(88200, 40);
    const fixture = path.join(temporary, "safe-silence.wav");
    await writeFile(fixture, wave);
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/third-party/verify-mediainfo.ps1"),
        "-Binary",
        path.join(runtime, "MediaInfo.dll"),
        "-Fixture",
        fixture,
      ],
      { windowsHide: true, stdio: "pipe", timeout: 30000 },
    );
  }
}
