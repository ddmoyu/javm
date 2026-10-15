import { describe, expect, it, vi } from "vite-plus/test";
import { createMediaProbe } from "../frontend/src/services/downloads/probe";
import type { MediaProbe, MediaRequest } from "../frontend/src/services/downloads/probe";

const audio: MediaProbe = {
  video: false,
  audio: true,
  videoTracks: 0,
  audioTracks: 1,
  durationMs: 12000,
  width: 0,
  height: 0,
  audioChannels: 2,
  audioLanguage: "en",
};

describe("download media inspection", () => {
  it("accepts standalone audio from the official Extension", async () => {
    const request = vi.fn<MediaRequest>(async () => audio);
    await expect(
      createMediaProbe(request)("E:/audio.m4a", new AbortController().signal),
    ).resolves.toEqual(audio);
    expect(request).toHaveBeenCalledWith("media.probe", {
      id: expect.any(String),
      path: "E:/audio.m4a",
    });
  });
  it("does not dispatch a cancelled request", async () => {
    const request = vi.fn<MediaRequest>();
    const controller = new AbortController();
    controller.abort();
    await expect(createMediaProbe(request)("E:/video.mp4", controller.signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("cancels the same native job once and rejects a late successful result", async () => {
    let complete!: (value: MediaProbe) => void;
    const request = vi.fn<MediaRequest>(async (method: string) => {
      if (method === "media.probe")
        return await new Promise<MediaProbe>((resolve) => {
          complete = resolve;
        });
      complete(audio);
      return {};
    });
    const controller = new AbortController();
    const pending = createMediaProbe(request)("E:/video.mp4", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual([
      "media.cancelProbe",
      { id: (request.mock.calls[0]![1] as { id: string }).id },
    ]);
  });
  it.each([
    { ...audio, audio: false },
    { ...audio, durationMs: -1 },
  ])("rejects invalid media results", async (result) => {
    const request = vi.fn<MediaRequest>(async () => result);
    await expect(
      createMediaProbe(request)("E:/invalid.mp4", new AbortController().signal),
    ).rejects.toThrow("没有可识别");
  });
});
