import { describe, expect, it, vi } from "vite-plus/test";
import {
  localMediaLocation,
  canMountMediaDirectory,
  playbackRequest,
  responseFormat,
} from "../frontend/src/services/playback/source";
import { PlaybackService } from "../frontend/src/services/playback/PlaybackService";
import type {
  PlaybackPort,
  PreparedPlayback,
} from "../frontend/src/services/playback/PlaybackService";

describe("playback sources", () => {
  it("preserves signed HLS URLs and detects uppercase extensions without consuming query strings", () => {
    const source = "https://example.test/STREAM.M3U8?token=a%2Fb+%25&quality=1080#v";
    expect(playbackRequest(source)).toMatchObject({ source, format: "hls", kind: "network" });
    expect(playbackRequest("https://example.test/media?id=1").format).toBeUndefined();
    expect(playbackRequest("https://example.test/media?id=1", { format: "hls" }).format).toBe(
      "hls",
    );
    expect(responseFormat("application/x-mpegURL; charset=UTF-8")).toBe("hls");
  });
  it("preserves Unicode, spaces, hashes and percent characters in local paths", () => {
    expect(playbackRequest("E:\\电影\\测试 & 100% #1.mp4").source).toBe(
      "E:/电影/测试 & 100% #1.mp4",
    );
    expect(localMediaLocation("file:///E:/%E7%94%B5%E5%BD%B1/a%23b.mp4")).toEqual({
      directory: "E:/电影",
      fileName: "a#b.mp4",
    });
    expect(playbackRequest("\\\\nas\\videos\\movie.mkv").kind).toBe("local");
  });
  it.each([
    "javascript:alert(1)",
    "data:video/mp4;base64,AAAA",
    "ftp://host/a.mp4",
    "a.mp4",
    "C:/clips/../private/a.mp4",
    "C:/clips/run.exe",
    "https://u:p@example.test/a.mp4",
    "https://example.test/a\n.mp4",
  ])("rejects unsafe or ambiguous input %s", (source) => {
    expect(() => playbackRequest(source)).toThrow();
  });
  it.each(["C:/video.mp4", "//nas/share/video.mp4"])(
    "does not mount an entire disk or share for %s",
    (source) => {
      expect(canMountMediaDirectory(localMediaLocation(source).directory)).toBe(false);
    },
  );
});

function fixture() {
  const media = (): PreparedPlayback => ({
    request: playbackRequest("https://example.test/a.m3u8"),
    url: "https://example.test/a.m3u8",
    format: "hls",
    dispose: vi.fn(async () => {}),
  });
  const port: PlaybackPort = {
    prepare: vi.fn(async () => media()),
  };
  return { service: new PlaybackService(port), port, media };
}

describe("single application playback session", () => {
  it("disposes a replaced source, closes immediately, and releases the final source", async () => {
    const { service, port } = fixture();
    await service.play("https://example.test/a.m3u8");
    const first = service.getSnapshot().media!;
    await service.play("https://example.test/b.mp4");
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(port.prepare).toHaveBeenCalledTimes(2);
    const last = service.getSnapshot().media!;
    const closing = service.close();
    expect(service.getSnapshot().opened).toBe(false);
    await closing;
    expect(last.dispose).toHaveBeenCalledOnce();
  });
  it("rejects extra preparation and cannot resurrect after close during slow I/O", async () => {
    const { service, port, media } = fixture();
    let resolve!: (value: PreparedPlayback) => void;
    port.prepare = vi.fn(
      () =>
        new Promise<PreparedPlayback>((done) => {
          resolve = done;
        }),
    );
    const opening = service.play("https://example.test/a.m3u8");
    await Promise.resolve();
    await expect(service.play("https://example.test/b.mp4")).rejects.toThrow("正在切换");
    const closing = service.close();
    const late = media();
    resolve(late);
    await Promise.all([opening, closing]);
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(service.getSnapshot()).toMatchObject({ opened: false, preparing: false });
    expect(service.getSnapshot().media).toBeUndefined();
  });
  it("keeps errors reviewable and allows playing the source again", async () => {
    const { service, port, media } = fixture();
    port.prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("文件已移走"))
      .mockResolvedValueOnce(media());
    await expect(service.play("C:/clips/a.mp4", { title: "影片" })).rejects.toThrow("文件已移走");
    expect(service.getSnapshot()).toMatchObject({ opened: true, error: "文件已移走" });
    await service.play("C:/clips/a.mp4", { title: "影片" });
    expect(service.getSnapshot().error).toBeUndefined();
    await service.shutdown();
    await expect(service.play("C:/clips/b.mp4")).rejects.toThrow("正在退出");
  });
  it("retains a failed cleanup and prevents overlapping close and prepare", async () => {
    const { service, port, media } = fixture();
    const prepared = media();
    prepared.dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error("卸载失败"))
      .mockResolvedValue(undefined);
    port.prepare = vi.fn(async () => prepared);
    await service.play("C:/clips/a.mp4");
    await expect(service.close()).rejects.toThrow("卸载失败");
    const closing = service.close();
    await expect(service.play("C:/clips/b.mp4")).rejects.toThrow("正在切换");
    await closing;
    expect(prepared.dispose).toHaveBeenCalledTimes(2);
    expect(port.prepare).toHaveBeenCalledOnce();
  });
});
