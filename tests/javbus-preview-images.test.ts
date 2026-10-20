import { describe, expect, it } from "vite-plus/test";
import { parseJavbusWorkDetails } from "../frontend/src/services/catalog/javbusWorks";
import { movieDetailsToFilm } from "../frontend/src/features/resources/movieDetailsFilm";

// 仅解析虚构 HTML，不发起请求，不保存或显示真实图片。
const work = {
  code: "SAFE-001",
  title: "安全自然纪录片",
  url: "https://www.javbus.com/SAFE-001_2026-01-01",
};
const page = (body: string) =>
  `<h3>安全自然纪录片</h3><div class="info"><p>ID: SAFE-001</p></div>${body}`;
const sample = (href: string, img = "https://images.example.invalid/thumb.jpg") =>
  `<a class="sample-box gallery" href="${href}"><div class="photo-frame"><img src="${img}"></div></a>`;
const parse = (body: string) => parseJavbusWorkDetails(page(body), work);

describe("JavBus 详情预览截图（安全 mock）", () => {
  it("提取六张样品图的原图地址，并传递到影片详情截图字段", () => {
    const urls = Array.from(
      { length: 6 },
      (_, index) => `https://images.example.invalid/sample-${index + 1}.jpg`,
    );
    const details = parse(urls.map((url) => sample(url)).join(""));
    expect(details.previewImages).toEqual(urls);
    const film = movieDetailsToFilm(details, { ...work, provider: "JavBus", id: work.code });
    expect(film.screenshots).toEqual(
      urls.map((src, index) => ({ src, title: `预览图 ${index + 1}` })),
    );
    expect(film.metadata?.homepage).toBe(work.url);
  });
  it("保留页面顺序并去重，解码 HTML 实体、相对地址和省略协议的地址", () => {
    const urls = [
      "/samples/one.jpg",
      "//images.example.invalid/two.jpg?width=800&amp;format=jpg",
      "/samples/one.jpg",
    ];
    expect(parse(urls.map((url) => sample(url)).join("")).previewImages).toEqual([
      "https://www.javbus.com/samples/one.jpg",
      "https://images.example.invalid/two.jpg?width=800&format=jpg",
    ]);
  });
  it("无原图链接时回退到懒加载图片，忽略占位锚点和无效协议", () => {
    const body = `<a class="sample-box" href="#"><img data-src="https://images.example.invalid/lazy.jpg" src="data:image/gif;base64,R0lGODlh"></a>
      <a class="sample-box" href="javascript:void(0)"><img data-original="https://images.example.invalid/original.jpg"></a>
      <a class="sample-box"><img srcset="https://images.example.invalid/small.jpg 1x, https://images.example.invalid/large.jpg 2x"></a>`;
    expect(parse(body).previewImages).toEqual([
      "https://images.example.invalid/lazy.jpg",
      "https://images.example.invalid/original.jpg",
      "https://images.example.invalid/small.jpg",
    ]);
  });
  it("不把封面、头像、相关推荐、脚本和注释中的图片当成截图", () => {
    const ignored = sample("https://images.example.invalid/ignored.jpg");
    const body = `<a class="bigImage" href="https://images.example.invalid/cover.jpg"><img /></a>
      <a class="avatar-box" href="/star/safe"><img src="https://images.example.invalid/portrait.jpg"></a>
      <a class="not-sample-box" href="https://images.example.invalid/related.jpg"><img /></a>
      <script>${ignored}</script><template>${ignored}</template><!-- ${ignored} -->
      ${sample("https://images.example.invalid/valid.jpg")}`;
    expect(parse(body).previewImages).toEqual(["https://images.example.invalid/valid.jpg"]);
  });
  it("拒绝文件、脚本、认证地址和控制字符，缺少有效地址时留空", () => {
    const urls = [
      "file:///C:/safe.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://user:password@images.example.invalid/a.jpg",
      "https://images.example.invalid/a&#10;.jpg",
    ];
    expect(
      parse(urls.map((url) => `<a class="sample-box" href="${url}"></a>`).join("")).previewImages,
    ).toEqual([]);
  });
  it("设置一百张上限，避免异常页面触发无界图片请求", () => {
    const details = parse(
      Array.from({ length: 110 }, (_, index) =>
        sample(`https://images.example.invalid/${index}.jpg`),
      ).join(""),
    );
    expect(details.previewImages).toHaveLength(100);
    expect(details.previewImages?.at(-1)).toBe("https://images.example.invalid/99.jpg");
  });
  it("没有样品图区的详情仍然有效，不把缺图误报成解析失败", () => {
    expect(parse("").previewImages).toEqual([]);
  });
  it("带发行日期后缀和分区的详情仍校验身份，并按当前页解析相对图片", () => {
    const uncensored = { ...work, url: "https://www.javbus.com/uncensored/SAFE-001_2026-01-01" };
    expect(
      parseJavbusWorkDetails(page(sample("samples/one.jpg")), uncensored).previewImages,
    ).toEqual(["https://www.javbus.com/uncensored/samples/one.jpg"]);
    expect(() =>
      parseJavbusWorkDetails(
        page(sample("/safe.jpg")).replace("ID: SAFE-001", "ID: WRONG-001"),
        work,
      ),
    ).toThrow("身份不一致");
  });
});
