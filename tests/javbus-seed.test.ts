import { expect, it, vi } from "vite-plus/test";
import { javbusEntryFromEntity } from "../frontend/src/services/catalog/javbusCatalog";

it("生产 SQLite 批次保留明确数量，开发模式不请求真实目录", async () => {
  const now = Date.now();
  const rows = {
    actresses: javbusEntryFromEntity(
      { id: "star:safe-a", name: "安全演员甲", url: "https://www.javbus.com/star/safe-a" },
      "actresses",
      now,
      417,
    ),
    studios: javbusEntryFromEntity(
      { id: "studio:safe-s", name: "安全制作商甲", url: "https://www.javbus.com/studio/safe-s" },
      "studios",
      now,
      0,
    ),
    labels: javbusEntryFromEntity(
      { id: "label:safe-l", name: "安全发行商甲", url: "https://www.javbus.com/label/safe-l" },
      "labels",
      now,
      1234,
    ),
  };
  const request = vi.fn(() => {
    throw new Error("Safe fixture must not fetch");
  });
  vi.stubGlobal("fetch", request);
  try {
    vi.stubEnv("DEV", true);
    vi.resetModules();
    const samples = await (
      await import("../frontend/src/services/catalog/javbusSeed")
    ).loadJavbusSeed();
    expect(samples.every((entry) => entry.name.startsWith("示例"))).toBe(true);
    expect(request).not.toHaveBeenCalled();
    vi.stubEnv("DEV", false);
    vi.resetModules();
    const { loadJavbusSeed, appendJavbusSeed } =
      await import("../frontend/src/services/catalog/javbusSeed");
    appendJavbusSeed(Object.values(rows), true, true);
    const entries = await loadJavbusSeed();
    expect(entries.map((entry) => [entry.dimension, entry.videoCount])).toEqual([
      ["actresses", 417],
      ["studios", 0],
      ["labels", 1234],
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(await loadJavbusSeed()).toBe(entries);
    expect(request).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
