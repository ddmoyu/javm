import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** 开发机完整 FFmpeg 验证；应用包内的精简 FFmpeg 只负责下载后的无损封装。 */
export async function verifyPublicResourceFile(root) {
  const temporary = path.resolve(import.meta.dirname, "../.tmp");
  root = path.resolve(root);
  if (
    path.dirname(root) !== temporary ||
    !path.basename(root).startsWith("public-resource-download-")
  )
    throw new Error("只能验证本工具创建的公开安全视频产物。");
  const resultPath = path.join(root, "result.json");
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  if (!result.ok || !result.output) throw new Error("下载尚未成功完成。");
  const file = path.resolve(result.output);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("视频产物不在本次隔离目录中。");
  try {
    const inspected = await execute(
      process.env.JAVM_VERIFY_FFPROBE || "ffprobe.exe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,channels",
        "-of",
        "json",
        file,
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const probe = JSON.parse(inspected.stdout);
    if (!probe.streams.some((stream) => stream.codec_type === "video" && stream.width > 0))
      throw new Error("ffprobe 未找到视频轨。");
    const decoded = await execute(
      process.env.JAVM_VERIFY_FFMPEG || "ffmpeg.exe",
      [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-nostdin",
        "-nostats",
        "-progress",
        "pipe:1",
        "-threads",
        "2",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "NUL",
      ],
      { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 },
    );
    const frames = Number([...decoded.stdout.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)?.[1]);
    if (!decoded.stdout.includes("progress=end") || !Number.isSafeInteger(frames) || frames < 100)
      throw new Error("没有完成视频全程解码。");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    Object.assign(result, {
      ffprobe: probe,
      decode: { ok: true, frames, stderr: decoded.stderr, entireFile: true },
      sha256: digest.digest("hex"),
    });
  } catch (error) {
    result.ok = false;
    result.decode = { ok: false, error: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  }
  return result;
}
