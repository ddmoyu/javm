import { expect, it, vi } from "vite-plus/test";
import {
  javbusEntryFromEntity,
  serializeJavbusCsv,
} from "../frontend/src/services/catalog/javbusCatalog";

it("生产内置名单读取明确数量，开发模式不请求真实目录", async () => {
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
  const request = vi.fn(async (url: string) => {
    const dimension = Object.keys(rows).find((key) => url.includes(`/${key}.csv`)) as
      | keyof typeof rows
      | undefined;
    return new Response(serializeJavbusCsv(dimension ? [rows[dimension]] : [], now));
  });
  vi.stubGlobal("fetch", request);
  try {
    vi.stubEnv("DEV", true);
    vi.resetModules();
    expect(
      await (await import("../frontend/src/services/catalog/javbusSeed")).loadJavbusSeed(),
    ).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    vi.stubEnv("DEV", false);
    vi.resetModules();
    const { loadJavbusSeed } = await import("../frontend/src/services/catalog/javbusSeed");
    const entries = await loadJavbusSeed();
    expect(entries.map((entry) => [entry.dimension, entry.videoCount])).toEqual([
      ["actresses", 417],
      ["studios", 0],
      ["labels", 1234],
    ]);
    expect(request).toHaveBeenCalledTimes(7);
    expect(await loadJavbusSeed()).toBe(entries);
    expect(request).toHaveBeenCalledTimes(7);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
