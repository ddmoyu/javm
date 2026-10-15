import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setUsageRecorder } from "../frontend/src/services/analytics/events";
import { PlayerWindowController } from "../frontend/src/services/playback/PlayerWindowController";
import { PreferredPlaybackController } from "../frontend/src/services/playback/PreferredPlaybackController";
import { PlaybackSettingsService } from "../frontend/src/services/playback/PlaybackSettingsService";
import { playerChannelName } from "../frontend/src/services/playback/windowChannel";
import type { PlayerWindowMessage } from "../frontend/src/services/playback/windowChannel";
import { ResourceSearchService } from "../frontend/src/services/streamResolution/ResourceSearchService";
import { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type { DownloadTask } from "../frontend/src/contracts/downloads";
import type { DownloadEngine, DownloadRepository } from "../frontend/src/services/downloads/ports";

afterEach(() => {
  setUsageRecorder();
  vi.unstubAllGlobals();
});
class Channel {
  static all = new Set<Channel>();
  onmessage?: (event: { data: PlayerWindowMessage }) => void;
  constructor(readonly name: string) {
    Channel.all.add(this);
  }
  postMessage(data: PlayerWindowMessage) {
    for (const peer of Channel.all)
      if (peer !== this && peer.name === this.name)
        queueMicrotask(() => {
          if (Channel.all.has(peer)) peer.onmessage?.({ data });
        });
  }
  close() {
    Channel.all.delete(this);
  }
}
describe("业务统计口径（全部为安全模拟）", () => {
  it("再次打开相同播放源仅激活窗口，不重复计数", async () => {
    const record = vi.fn();
    setUsageRecorder(record);
    vi.stubGlobal("BroadcastChannel", Channel);
    const children: Channel[] = [];
    const internal = new PlayerWindowController(async (id) => {
      const child = new Channel(playerChannelName(id));
      children.push(child);
      child.onmessage = ({ data }) => {
        if (data.type !== "command") return;
        if (data.command.action === "close") child.postMessage({ type: "closed" });
        else child.postMessage({ type: "result", id: data.id });
      };
      child.postMessage({ type: "ready" });
    });
    const settings = new PlaybackSettingsService({ read: async () => null, write: async () => {} });
    const playback = new PreferredPlaybackController(internal, settings, async () => {});
    try {
      await playback.play("C:/safe-fixture/documentary.mp4");
      await playback.play("C:/safe-fixture/documentary.mp4");
      expect(record.mock.calls).toEqual([["play_video_count"]]);
      await playback.play("C:/safe-fixture/landscape.mp4");
      expect(record).toHaveBeenCalledTimes(2);
    } finally {
      await playback.shutdown();
      for (const child of children) child.close();
    }
  });
  it("多个来源只计一次搜索，手动重试计一次，非法查询不计数", async () => {
    const record = vi.fn();
    setUsageRecorder(record);
    const resolution = new ResolutionService({
      http: async () => {
        throw new Error("不应联网");
      },
      parser: {
        run: async () => {
          throw new Error("不应解析");
        },
        close() {},
      },
      webview: async () => [],
    });
    const sources = ["one", "two", "three"].map((id) => ({
      id,
      name: id,
      template: `https://safe.example.invalid/${id}/{code}`,
    }));
    const search = new ResourceSearchService(
      resolution,
      { add: async () => 1, directory: () => "safe" },
      sources,
    );
    try {
      search.search("../invalid");
      expect(record).not.toHaveBeenCalled();
      search.search("DEMO-001");
      await vi.waitFor(() => expect(search.getSnapshot().searching).toBe(false));
      expect(search.getSnapshot().rows).toHaveLength(3);
      expect(record.mock.calls).toEqual([["search_resource_link_count"]]);
      search.retry("one");
      await vi.waitFor(() => expect(search.getSnapshot().searching).toBe(false));
      expect(record.mock.calls).toEqual([
        ["search_resource_link_count"],
        ["search_resource_link_count"],
      ]);
    } finally {
      await search.shutdown();
      await resolution.shutdown();
    }
  });
  it("下载失败持久化后计一次，重载不重计，重试完成独立计成功", async () => {
    const record = vi.fn();
    setUsageRecorder(record);
    let tasks: DownloadTask[] = [];
    const repository: DownloadRepository = {
      load: async () => ({
        tasks: structuredClone(tasks),
        settings: { ...defaultDownloadSettings, directory: "C:/safe-fixture" },
      }),
      save: async (task, expected) => {
        expect(tasks.find((item) => item.id === task.id)?.revision ?? 0).toBe(expected);
        tasks = [...tasks.filter((item) => item.id !== task.id), structuredClone(task)];
      },
      saveSettings: async () => {},
      remove: async () => {},
      close: async () => {},
    };
    const engine: DownloadEngine = {
      defaultDirectory: async () => "C:/safe-fixture",
      outputSize: async () => 1,
      checkTools: async () => [],
      open: async () => {},
      run: vi
        .fn<DownloadEngine["run"]>()
        .mockRejectedValueOnce(new Error("安全模拟失败"))
        .mockResolvedValue(undefined),
    };
    const service = new DownloadService(repository, engine);
    await service.initialize();
    await service.add({
      urls: ["https://safe.example.invalid/documentary.mp4"],
      directory: "C:/safe-fixture",
      kind: "auto",
      headers: {},
    });
    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe("failed"));
    expect(record.mock.calls).toEqual([["download_video_failed_count"]]);
    await service.shutdown();
    const restarted = new DownloadService(repository, engine);
    try {
      await restarted.initialize();
      expect(record).toHaveBeenCalledTimes(1);
      await restarted.resume(tasks[0]!.id);
      await vi.waitFor(() => expect(restarted.getSnapshot().tasks[0]?.status).toBe("completed"));
      expect(record.mock.calls).toEqual([
        ["download_video_failed_count"],
        ["download_video_count"],
      ]);
    } finally {
      await restarted.shutdown();
    }
  });
});
