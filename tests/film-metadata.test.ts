import { describe, expect, it } from "vite-plus/test";
import type { Film } from "../frontend/src/contracts/media";
import { getFacetValues, getFilmMetadata } from "../frontend/src/features/films/filmMetadata";

// 测试输入仅存在于测试目录，正式入口不导入任何测试影片。
const film: Film = {
  id: 21,
  code: "",
  title: "未整理文件",
  english: "",
  year: 0,
  duration: 0,
  genre: "",
  quality: "4K",
  size: "",
  favorite: false,
  missing: true,
};

describe("正式界面的空资料边界", () => {
  it("缺少元数据时不推断日期、导演、来源、分辨率或文件路径", () => {
    expect(getFilmMetadata(film)).toEqual({
      originalTitle: "",
      premiered: "",
      actors: [],
      director: "",
      studio: "",
      series: "",
      genres: [],
      resolution: "",
      directory: "",
      fileName: "",
      source: "",
    });
    expect(getFacetValues(film, "导演")).toEqual([]);
    expect(getFacetValues(film, "制作商")).toEqual([]);
  });

  it("关联浏览只使用输入中已有的演员和分类", () => {
    const known = { ...film, actor: "已有演员", genre: "纪录片" };
    expect(getFacetValues(known, "演员")).toEqual(["已有演员"]);
    expect(getFacetValues(known, "分类")).toEqual(["纪录片"]);
    expect(getFacetValues(known, "系列")).toEqual([]);
  });
});
