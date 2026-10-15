import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PlayerWindowController } from "../frontend/src/services/playback/PlayerWindowController";
import { playerChannelName, playerWindowId } from "../frontend/src/services/playback/windowChannel";
import type { PlayerWindowMessage } from "../frontend/src/services/playback/windowChannel";
import type { PlaybackWindowMode } from "../frontend/src/services/playback/PlaybackSettingsService";
import { playbackRequest } from "../frontend/src/services/playback/source";

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
beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", Channel);
  vi.useFakeTimers();
});
afterEach(() => {
  Channel.all.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function fixture(autoReady = true) {
  let child!: Channel;
  const commands: Extract<PlayerWindowMessage, { type: "command" }>[] = [];
  const launch = vi.fn(async (id: string) => {
    child = new Channel(playerChannelName(id));
    child.onmessage = ({ data }) => {
      if (data.type === "command") commands.push(data);
    };
    if (autoReady) child.postMessage({ type: "ready" });
  });
  const service = new PlayerWindowController(launch);
  return {
    service,
    launch,
    commands,
    send: (message: PlayerWindowMessage) => child.postMessage(message),
  };
}
const source = "https://example.test/a.mp4?secret=a%2Fb&token=x";

describe("independent player window lifecycle", () => {
  it("reuses one window, preserves the source and rejects overlapping preparations", async () => {
    const { service, launch, commands, send } = fixture();
    const first = service.play(source);
    await expect(service.play(source)).rejects.toThrow("正在切换");
    await flush();
    expect(commands[0]!.command).toMatchObject({ action: "play", request: { source } });
    send({ type: "result", id: commands[0]!.id });
    await first;
    const second = service.play("C:/测试 # &/视频.mp4");
    await flush();
    send({ type: "result", id: commands[1]!.id });
    await second;
    expect(launch).toHaveBeenCalledOnce();
  });
  it("close during window startup never sends the pending play command", async () => {
    const { service, commands, send } = fixture(false);
    const opening = service.play(source);
    const closing = service.close();
    await flush();
    send({ type: "ready" });
    await flush();
    expect(commands.map((message) => message.command.action)).toEqual(["close"]);
    send({ type: "closed" });
    await Promise.all([opening, closing]);
    expect(service.getSnapshot().opened).toBe(false);
  });
  it("close bypasses a slow play command and rejects it when the child closes", async () => {
    const { service, commands, send } = fixture();
    const opening = service.play(source);
    const rejected = expect(opening).rejects.toThrow("已关闭");
    await flush();
    const closing = service.close();
    await flush();
    expect(commands.map((message) => message.command.action)).toEqual(["play", "close"]);
    send({ type: "closed" });
    await Promise.all([rejected, closing]);
    expect(service.getSnapshot()).toMatchObject({ opened: false, preparing: false });
  });
  it("keeps the connection for a failed cleanup so close can be retried", async () => {
    const { service, launch, commands, send } = fixture();
    const opening = service.play(source);
    await flush();
    send({ type: "result", id: commands[0]!.id });
    await opening;
    const closing = service.close();
    const rejected = expect(closing).rejects.toThrow("挂载清理失败");
    await flush();
    send({ type: "result", id: "close", error: "挂载清理失败" });
    await rejected;
    const retry = service.close();
    await flush();
    send({ type: "closed" });
    await retry;
    expect(launch).toHaveBeenCalledOnce();
    expect(service.getSnapshot().opened).toBe(false);
  });
  it("releases a failed startup and allows the next attempt to create a new window", async () => {
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("创建失败"))
      .mockRejectedValueOnce(new Error("再次失败"));
    const service = new PlayerWindowController(launch);
    await expect(service.play(source)).rejects.toThrow("创建失败");
    await expect(service.play(source)).rejects.toThrow("再次失败");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(Channel.all.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds startup time and prevents new requests after shutdown", async () => {
    const { service } = fixture(false);
    const opening = service.play(source);
    const rejected = expect(opening).rejects.toThrow("启动超时");
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    await service.shutdown();
    await expect(service.play(source)).rejects.toThrow("正在退出");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("requires a generated window id to enter the child bootstrap", () => {
    expect(playerWindowId("?javmPlayer=invalid")).toBeUndefined();
    const id = crypto.randomUUID();
    expect(playerWindowId(`?javmPlayer=${id}`)).toBe(id);
  });
});

function multipleWindows() {
  let mode: PlaybackWindowMode = "new";
  const children: {
    channel: Channel;
    commands: Extract<PlayerWindowMessage, { type: "command" }>[];
    closeError?: string;
  }[] = [];
  const launch = vi.fn(async (id: string) => {
    const child: (typeof children)[number] = {
      channel: new Channel(playerChannelName(id)),
      commands: [],
    };
    children.push(child);
    child.channel.onmessage = ({ data }) => {
      if (data.type !== "command") return;
      child.commands.push(data);
      if (data.command.action === "play")
        child.channel.postMessage({
          type: "state",
          snapshot: {
            opened: true,
            preparing: false,
            request: data.command.request,
            revision: child.commands.length,
          },
        });
      if (data.command.action === "close" && !child.closeError) {
        child.channel.postMessage({ type: "closed" });
        child.channel.close();
      } else
        child.channel.postMessage({
          type: "result",
          id: data.id,
          error: data.command.action === "close" ? child.closeError : undefined,
        });
    };
    child.channel.postMessage({ type: "ready" });
  });
  const service = new PlayerWindowController(launch, () => mode);
  return {
    service,
    launch,
    children,
    setMode: (value: PlaybackWindowMode) => {
      mode = value;
    },
    closeChild: async (index: number) => {
      children[index]!.channel.postMessage({ type: "closed" });
      children[index]!.channel.close();
      await flush();
    },
  };
}

describe("多个独立播放窗口", () => {
  it.each(["new", "reuse"] as const)(
    "%s 模式重复打开已有视频只激活其窗口，不替换其他视频",
    async (mode) => {
      const { service, children, setMode } = multipleWindows();
      await service.play("C:/a.mp4", { title: "最初的标题" });
      await service.play("C:/b.mp4");
      setMode(mode);
      await service.play("C:/a.mp4", { title: "来自另一个入口", format: "video" });
      expect(children).toHaveLength(2);
      expect(children[0]!.commands.map(({ command }) => command.action)).toEqual(["play", "focus"]);
      expect(children[1]!.commands).toHaveLength(1);
      expect(service.getSnapshot().request?.source).toBe("C:/b.mp4");
      await service.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("Windows 大小写、分隔符及 file URL 指向同一窗口", async () => {
    const { service, children } = multipleWindows();
    await service.play("C:/Videos/测试 & 100% #1.mp4");
    await service.play("c:\\videos\\测试 & 100% #1.MP4");
    await service.play("file:///C:/Videos/%E6%B5%8B%E8%AF%95%20%26%20100%25%20%231.mp4");
    expect(children).toHaveLength(1);
    expect(children[0]!.commands.map(({ command }) => command.action)).toEqual([
      "play",
      "focus",
      "focus",
    ]);
    await service.shutdown();
  });
  it("网络完整地址相同才复用，查询参数或本地目录不同仍可多开", async () => {
    const { service, children } = multipleWindows();
    await service.play(source);
    await service.play(source.replace("https://example.test", "https://EXAMPLE.test:443"));
    expect(children).toHaveLength(1);
    expect(children[0]!.commands.at(-1)?.command.action).toBe("focus");
    await service.play(source.replace("token=x", "token=y"));
    await service.play("C:/first/a.mp4");
    await service.play("C:/second/a.mp4");
    expect(children).toHaveLength(4);
    await service.shutdown();
  });
  it("关闭或换片后释放原视频的窗口归属", async () => {
    const { service, children, setMode, closeChild } = multipleWindows();
    await service.play("C:/a.mp4");
    setMode("reuse");
    await service.play("C:/b.mp4");
    setMode("new");
    await service.play("C:/a.mp4");
    expect(children).toHaveLength(2);
    await closeChild(1);
    await service.play("C:/a.mp4");
    expect(children).toHaveLength(3);
    await service.play("C:/b.mp4");
    expect(children).toHaveLength(3);
    expect(children[0]!.commands.at(-1)?.command.action).toBe("focus");
    await service.shutdown();
  });
  it("同一视频加载失败后再次点击，在原窗口重试", async () => {
    const { service, children } = multipleWindows();
    await service.play(source);
    children[0]!.channel.postMessage({
      type: "state",
      snapshot: {
        opened: true,
        preparing: false,
        revision: 1,
        request: playbackRequest(source),
        error: "网络失败",
      },
    });
    await flush();
    await service.play(source);
    expect(children).toHaveLength(1);
    expect(children[0]!.commands.map(({ command }) => command.action)).toEqual(["play", "play"]);
    expect(service.getSnapshot().error).toBeUndefined();
    await service.shutdown();
  });
  it("新窗口保留旧视频，切回复用只替换最近打开的窗口", async () => {
    const { service, children, setMode } = multipleWindows();
    await service.play("C:/a.mp4");
    await service.play(source);
    expect(children).toHaveLength(2);
    expect(children[0]!.commands).toHaveLength(1);
    setMode("reuse");
    await service.play("C:/b.mp4");
    expect(children).toHaveLength(2);
    expect(children[0]!.commands).toHaveLength(1);
    expect(children[1]!.commands[1]!.command).toMatchObject({
      action: "play",
      request: { source: "C:/b.mp4" },
    });
    await service.shutdown();
    expect(Channel.all.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("后台窗口的状态与关闭不覆盖当前影片，关闭最近窗口后回退到仍打开的窗口", async () => {
    const { service, children, setMode, closeChild } = multipleWindows();
    await service.play("C:/a.mp4");
    await service.play("C:/b.mp4");
    await service.play("C:/c.mp4");
    children[0]!.channel.postMessage({
      type: "state",
      snapshot: { opened: false, preparing: false, revision: 10 },
    });
    await closeChild(0);
    expect(service.getSnapshot().request?.source).toBe("C:/c.mp4");
    await closeChild(2);
    expect(service.getSnapshot().request?.source).toBe("C:/b.mp4");
    setMode("reuse");
    await service.play(source);
    expect(children).toHaveLength(3);
    expect(children[1]!.commands.at(-1)?.command).toMatchObject({
      action: "play",
      request: { source },
    });
    await service.shutdown();
    expect(service.getSnapshot().opened).toBe(false);
  });
  it("新建失败保留已有窗口，再次播放当前影片只激活原窗口", async () => {
    const { service, launch, children } = multipleWindows();
    await service.play(source);
    launch.mockRejectedValueOnce(new Error("创建失败"));
    await expect(service.play("C:/b.mp4")).rejects.toThrow("创建失败");
    expect(service.getSnapshot()).toMatchObject({ opened: true, request: { source } });
    await service.play(source);
    expect(children).toHaveLength(1);
    expect(children[0]!.commands.map(({ command }) => command.action)).toEqual(["play", "focus"]);
    await service.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("一个窗口清理失败仍关闭其他窗口，再次退出只重试失败窗口", async () => {
    const { service, children } = multipleWindows();
    await service.play("C:/a.mp4");
    await service.play("C:/b.mp4");
    children[0]!.closeError = "进度保存失败";
    await expect(service.shutdown()).rejects.toThrow("进度保存失败");
    expect(children[1]!.commands.at(-1)?.command.action).toBe("close");
    expect(service.getSnapshot().opened).toBe(true);
    await expect(service.play(source)).rejects.toThrow("正在退出");
    children[0]!.closeError = undefined;
    await service.shutdown();
    expect(children[0]!.commands).toHaveLength(3);
    expect(children[1]!.commands).toHaveLength(2);
    expect(Channel.all.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
