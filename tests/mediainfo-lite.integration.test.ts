import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIAINFO_INTEGRATION === "1";
const executable = process.env.JAVM_DATABASE_EXE || path.join(project, "bin/javm_database.exe");
const reference = process.env.JAVM_MEDIAINFO_REFERENCE_EXE;
interface Probe {
  video: boolean;
  audio: boolean;
  videoTracks: number;
  audioTracks: number;
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  audioChannels: number;
  audioLanguage: string;
}
const cases = [
  { file: "H264-AAC.mp4", video: "libx264", audio: "aac" },
  { file: "HEVC-AAC.mkv", video: "libx265", audio: "aac" },
  { file: "AV1-Opus.webm", video: "libaom-av1", audio: "libopus" },
  { file: "VP9-Opus.webm", video: "libvpx-vp9", audio: "libopus" },
  { file: "MPEG4-MP3.avi", video: "mpeg4", audio: "libmp3lame" },
  { file: "H264-PCM.mov", video: "libx264", audio: "pcm_s16le" },
  { file: "H264-AC3.m2ts", video: "libx264", audio: "ac3" },
  { file: "MPEG2-MP2.mpg", video: "mpeg2video", audio: "mp2" },
  { file: "WMV2-WMA.wmv", video: "wmv2", audio: "wmav2" },
  { file: "FLV1-MP3.flv", video: "flv", audio: "libmp3lame" },
  { file: "Theora-Vorbis.ogv", video: "libtheora", audio: "libvorbis" },
  { file: "RV10-AC3.rm", video: "rv10", audio: "ac3" },
  { file: "MPEG4-AAC.3gp", video: "mpeg4", audio: "aac" },
  { file: "audio.m4a", audio: "aac" },
  { file: "audio.aac", audio: "aac" },
  { file: "audio.mp3", audio: "libmp3lame" },
  { file: "audio.ac3", audio: "ac3" },
  { file: "audio.eac3", audio: "eac3" },
  { file: "audio.flac", audio: "flac" },
  { file: "audio.opus", audio: "libopus" },
  { file: "audio.wav", audio: "pcm_s16le" },
];

describe.runIf(enabled)("trimmed MediaInfo real format compatibility", () => {
  let root: string;
  const evidence: unknown[] = [];
  beforeAll(async () => {
    await mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await mkdtemp(path.join(project, ".tmp/mediainfo-formats-"));
  });
  async function probe(binary: string, file: string): Promise<Probe> {
    const { stdout } = await run(binary, ["--media-probe", file], {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
    });
    return JSON.parse(stdout) as Probe;
  }
  it.each(cases)(
    "reads $file with the original fields",
    async (fixture) => {
      const file = path.join(root, `中文 & 100% ${fixture.file}`);
      const args = ["-v", "error", "-nostdin", "-y"];
      if (fixture.video) args.push("-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25");
      args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2");
      if (fixture.video) args.push("-c:v", fixture.video, "-threads:v", "2");
      args.push("-c:a", fixture.audio, "-ac", "2", "-metadata:s:a:0", "language=eng", file);
      // Only this synthetic fixture generator uses a full development FFmpeg.
      await run(process.env.JAVM_FIXTURE_FFMPEG || "ffmpeg", args, {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      const actual = await probe(executable, file);
      expect(actual).toMatchObject({
        video: Boolean(fixture.video),
        audio: true,
        videoTracks: fixture.video ? 1 : 0,
        audioTracks: 1,
        audioChannels: 2,
      });
      // With the application's ParseSpeed=0.5, the original DLL also reports no
      // duration for this raw ADTS fixture. Preserve that behavior explicitly.
      if (fixture.file === "audio.aac") expect(actual.durationMs).toBe(0);
      else {
        expect(actual.durationMs).toBeGreaterThan(1500);
        expect(actual.durationMs).toBeLessThan(3000);
      }
      if (fixture.video) {
        expect(actual).toMatchObject({ width: 320, height: 240 });
        expect(actual.codec.length).toBeGreaterThan(0);
      }
      const original = reference ? await probe(reference, file) : undefined;
      if (original) expect(actual).toEqual(original);
      evidence.push({ file, actual, original });
      await writeFile(path.join(root, "results.json"), JSON.stringify(evidence, null, 2));
    },
    60000,
  );
  it("does not report media streams for invalid input", async () => {
    const file = path.join(root, "invalid.mp4");
    await writeFile(file, "This is a synthetic invalid video.");
    const actual = await probe(executable, file);
    expect(actual).toMatchObject({ video: false, audio: false, videoTracks: 0, audioTracks: 0 });
    if (reference) expect(actual).toEqual(await probe(reference, file));
  });
});
