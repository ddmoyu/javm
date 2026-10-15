import { describe, expect, it, vi } from "vite-plus/test";
import {
  ArtworkService,
  type ArtworkTarget,
  type ArtworkTools,
} from "../frontend/src/services/library/ArtworkService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";

const target: ArtworkTarget = {
  directory: "C:/fixture/metadata/safe/images",
  poster: "",
  code: "SAFE-001",
  title: "安全样例",
  source: {},
  videos: [],
};
function fixture(commitFails = false) {
  const calls: string[] = [];
  const request: LibraryPort["request"] = async <T>(method: string) => {
    calls.push(method);
    if (method.endsWith("prepare")) return target as T;
    if (commitFails) throw new Error("响应丢失");
    return { retired: [] } as T;
  };
  const tools: ArtworkTools = {
    mkdir: async () => {},
    read: async () => new ArrayBuffer(4),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    frame: async () => {},
    transform: async () => new ArrayBuffer(4),
    download: vi.fn(async () => {}),
    details: async () => ({
      fields: { code: "WRONG-002" },
      homepage: "https://safe.example.invalid",
      provider: "fixture",
      id: "1",
    }),
  };
  return { tools, calls, service: new ArtworkService({ request }, tools, async () => {}) };
}
describe("图片后台任务（安全 mock）", () => {
  it("取消后不会保存迟到的转换结果", async () => {
    const f = fixture();
    let finish!: (bytes: ArrayBuffer) => void;
    f.tools.transform = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = f.service.cover("safe", "C:/fixture/safe.png");
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.service.cancel();
    finish(new ArrayBuffer(4));
    await expect(pending).rejects.toThrow();
    expect(f.tools.write).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("library.artwork.commit");
    await f.service.shutdown();
  });
  it("提交响应丢失时保留图片，避免删除已入库文件", async () => {
    const f = fixture(true);
    await expect(f.service.cover("safe", "C:/fixture/safe.png")).rejects.toThrow("响应丢失");
    expect(f.tools.write).toHaveBeenCalledOnce();
    expect(vi.mocked(f.tools.remove).mock.calls.every(([path]) => path.includes("/.work-"))).toBe(
      true,
    );
    await f.service.shutdown();
  });
  it("番号不一致的图片来源不会下载或入库", async () => {
    const f = fixture();
    await expect(f.service.fetch("safe", true, true)).rejects.toThrow("不一致");
    expect(f.tools.download).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("library.artwork.commit");
    await f.service.shutdown();
  });
});
