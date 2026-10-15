import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

// A release must never silently fall back to a full development FFmpeg build.
export async function verifyFfmpegLite(directory, expected, env = process.env, buildReceipt) {
  const receipt =
    buildReceipt ?? JSON.parse(await readFile(path.join(directory, "ffmpeg-lite.json"), "utf8"));
  if (receipt.profile !== expected.profile || receipt.source.sha256 !== expected.sha256)
    throw new Error("FFmpeg lite source/profile mismatch; run pnpm offline:setup.");
  if (
    receipt.binaries.length !== 1 ||
    receipt.binaries[0].name !== "ffmpeg.exe" ||
    (await readdir(directory)).some((name) => name.toLowerCase() === "ffprobe.exe")
  )
    throw new Error("FFmpeg lite must not include ffprobe; media inspection uses MediaInfo.");
  const run = (binary, arg) =>
    execFileSync(path.join(directory, binary), ["-hide_banner", arg], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env,
    });
  for (const name of ["ffmpeg.exe"]) {
    const file = path.join(directory, name);
    const record = receipt.binaries.find((item) => item.name === name);
    const bytes = (await stat(file)).size;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (
      !record ||
      bytes !== record.bytes ||
      bytes > 25 * 1024 * 1024 ||
      digest.digest("hex") !== record.sha256
    )
      throw new Error(`FFmpeg lite executable mismatch: ${name}`);
    const version = run(name, "-version");
    if (!version.startsWith(`${name.slice(0, -4)} version 8.0.1 `))
      throw new Error(`Unexpected FFmpeg source version: ${name}`);
    for (const flag of [
      "--disable-everything",
      "--disable-network",
      "--disable-hwaccels",
      "--disable-ffprobe",
      "--enable-small",
      "--enable-static",
    ]) {
      if (!version.includes(flag)) throw new Error(`FFmpeg lite flag missing: ${flag}`);
    }
  }
  const protocols = [...run("ffmpeg.exe", "-protocols").matchAll(/^\s{2}(\w+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (
    !protocols.includes("file") ||
    !protocols.includes("pipe") ||
    !protocols.includes("crypto") ||
    // crypto 只在本地解密 AES-128 HLS 分片，仍不允许任何网络协议。
    protocols.some((name) => !["file", "pipe", "crypto"].includes(name))
  )
    throw new Error("FFmpeg lite must only use file/pipe/crypto protocols.");
  const encoders = [
    ...run("ffmpeg.exe", "-encoders").matchAll(/^\s*[VAS][A-Z.]{5}\s+(\w+)\s+/gm),
  ].map((match) => match[1]);
  if (encoders.length !== 1 || encoders[0] !== "mjpeg")
    throw new Error("FFmpeg lite must only retain the JPEG encoder.");
  const muxers = run("ffmpeg.exe", "-muxers");
  if (!/^\s*E\s+mp4\s/m.test(muxers) || !/^\s*E\s+image2\s/m.test(muxers))
    throw new Error("FFmpeg lite is missing MP4 remux or JPEG output.");
  return receipt;
}
