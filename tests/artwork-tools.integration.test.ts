import { describe, it, expect } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const run = promisify(execFile);
describe.runIf(enabled)("图片抽帧工具（纯色安全视频）", () => {
  it("本地生成纯色视频并提取 JPEG", async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/artwork-tools-"));
    const ffmpeg = path.resolve("bin/tools/ffmpeg.exe");
    const picture = path.join(root, "safe.ppm"),
      video = path.join(root, "safe.mp4"),
      frame = path.join(root, "frame.jpg");
    await fs.writeFile(
      picture,
      Buffer.concat([
        Buffer.from("P6\n64 48\n255\n"),
        Buffer.from(Array.from({ length: 64 * 48 * 3 }, (_, index) => [30, 90, 160][index % 3]!)),
      ]),
    );
    const command = (args: string[]) =>
      run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", ...args], {
        windowsHide: true,
        timeout: 20000,
      });
    await command([
      "-loop",
      "1",
      "-framerate",
      "2",
      "-i",
      picture,
      "-t",
      "2",
      "-c:v",
      "mjpeg",
      "-threads",
      "1",
      "-pix_fmt",
      "yuvj420p",
      "-an",
      video,
    ]);
    await command([
      "-protocol_whitelist",
      "file,pipe",
      "-ss",
      "0.5",
      "-i",
      video,
      "-an",
      "-sn",
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      frame,
    ]);
    expect((await fs.readFile(frame)).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
  }, 60000);
});
