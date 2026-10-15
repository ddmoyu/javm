import { describe, expect, it } from "vite-plus/test";
import {
  adRows,
  duplicateRows,
  normalizeKeywords,
  parentDirectory,
} from "../frontend/src/services/library/maintenanceRules";
import type { MaintenanceVideo } from "../frontend/src/contracts/maintenance";

const video = (id: string, extra: Partial<MaintenanceVideo> = {}): MaintenanceVideo => ({
  id,
  path: `D:/合成/${id}.mp4`,
  title: id,
  code: "",
  hash: "",
  size: 1024,
  duration: 6000,
  resolution: "1920x1080",
  missing: false,
  ...extra,
});
describe("重复与广告检查规则", () => {
  it("合并番号和指纹的交叉关联，完整时长优先于高分辨率，并识别跨目录", () => {
    const result = duplicateRows([
      video("normal", { code: "TEST-001", hash: "abc", duration: 6000, size: 2048 }),
      video("copy", {
        code: " test-001 ",
        hash: "def",
        duration: 2000,
        resolution: "4K",
        size: 9000,
      }),
      video("third", { path: "E:/合成/third.mp4", code: "TEST-002", hash: "def", duration: 5900 }),
      video("unique"),
    ]);
    expect(result.map((row) => row.id)).toEqual(["normal", "third", "copy"]);
    expect(result.every((row) => row.reason === "番号与文件指纹关联" && row.crossDirectory)).toBe(
      true,
    );
    expect(result.map((row) => row.suggested)).toEqual([false, true, true]);
    expect(result.every((row) => !row.selected)).toBe(true);
  });
  it("内容指纹可单独成组，空番号空指纹不形成重复组", () => {
    const result = duplicateRows([
      video("a", { hash: "abc" }),
      video("b", { hash: "abc" }),
      video("c"),
      video("d"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.reason).toBe("相同文件指纹");
  });
  it("完整、清晰度和大小相同时保留无副本后缀的文件", () => {
    const result = duplicateRows([
      video("a", { code: "X", path: "D:/片库/影片 (1).mp4" }),
      video("b", { code: "X", path: "D:/片库/影片.mp4" }),
    ]);
    expect(result[0]?.id).toBe("b");
  });
  it("排除词优先于零字节、重复文件名及标题关键词，未知大小不等同零字节", () => {
    const result = adRows(
      [
        video("empty", { size: 0 }),
        video("unknown", { size: null }),
        video("same1", { path: "D:/a/广告.mp4" }),
        video("same2", { path: "E:/b/广告.mp4" }),
        video("keyword", { title: "PROMO 合成视频" }),
        video("exclude", { title: "PROMO 正片", size: 0 }),
        video("folder", { path: "D:/promo/normal.mp4" }),
      ],
      { keywords: ["promo"], excludeKeywords: ["正片"], duplicateNames: true },
    );
    expect(result.map((row) => row.id)).toEqual(["empty", "same1", "same2", "keyword"]);
    expect(result.map((row) => row.reason)).toEqual([
      "文件大小为 0",
      "文件名重复 2 次",
      "文件名重复 2 次",
      "包含关键词：promo",
    ]);
    expect(
      adRows([video("a", { path: "D:/same.mp4" }), video("b", { path: "E:/same.mp4" })], {
        keywords: [],
        excludeKeywords: [],
        duplicateNames: false,
      }),
    ).toEqual([]);
    expect(normalizeKeywords([" PROMO ", "promo", "", "广告"])).toEqual(["PROMO", "广告"]);
    expect(parentDirectory("C:\\movie.mp4")).toBe("C:/");
  });
});
