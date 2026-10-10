import { ResolutionError, webUrl } from "./shared";

export interface ResourceSource {
  id: string;
  name: string;
  template: string;
  failRule?: { selector: string; text: string };
}
// 迁移旧版的定位模板，不自动探测网站。开发和验证仅注入本地安全来源。
export const resourceSources: readonly ResourceSource[] = [
  { id: "missav", name: "MissAV", template: "https://missav.ws/{code}" },
  {
    id: "thisav",
    name: "ThisAV",
    template: "https://thisav2.com/cn/{code}",
    failRule: { selector: "h1", text: "找不到页面" },
  },
  {
    id: "njav",
    name: "NJAV",
    template: "https://www.njav.com/zh/xvideos/{code}",
    failRule: { selector: ".message", text: "404 Not Found" },
  },
  { id: "jable", name: "Jable.tv", template: "https://jable.tv/videos/{code}/" },
  {
    id: "jptt",
    name: "JPTT.tv",
    template: "https://jptt.tv/video/{code}",
    failRule: { selector: "h1", text: "404 Not Found" },
  },
  {
    id: "javsb",
    name: "Jav.sb",
    template: "https://jav.sb/jav/{code}-1-1.html",
    failRule: { selector: ".badge", text: "404" },
  },
  {
    id: "123av",
    name: "123AV",
    template: "https://123av.com/zh/v/{code}",
    failRule: { selector: ".errpage__code", text: "404" },
  },
  {
    id: "myjav",
    name: "MyJav.tv",
    template: "https://cn.myjav.tv/video/{code}",
    failRule: { selector: "h1", text: "404" },
  },
  {
    id: "javgg",
    name: "JavGG",
    template: "https://javgg.net/jav/{code}/",
    failRule: { selector: ".no-result", text: "404" },
  },
  {
    id: "javct",
    name: "JavCT",
    template: "https://javct.net/v/{code}",
    failRule: { selector: ".page-404__title", text: "404" },
  },
  {
    id: "javmost",
    name: "JavMost",
    template: "https://www.javmost.ws/{CODE}/",
    failRule: { selector: "h1", text: "404" },
  },
  {
    id: "javeng",
    name: "JavEng",
    template: "https://javeng.tv/jav-eng-sub/{code}/",
    failRule: { selector: ".error404", text: "" },
  },
  {
    id: "javfull",
    name: "JavFull",
    template: "https://javfull.net/{code}/",
    failRule: { selector: "#notfound", text: "" },
  },
];
export function normalizeCode(input: string) {
  const code = input.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code) || !/\d/.test(code))
    throw new Error("请输入完整番号，只能包含字母、数字、短横线和下划线。");
  return code;
}
export function sourceRequest(source: ResourceSource, input: string) {
  const code = normalizeCode(input);
  if (!/\{(?:code|CODE)\}/.test(source.template)) throw new ResolutionError("invalid_input");
  const url = webUrl(
    source.template
      .replaceAll("{code}", encodeURIComponent(code.toLowerCase()))
      .replaceAll("{CODE}", encodeURIComponent(code)),
  );
  return { url, provider: "webview" as const, failRule: source.failRule };
}
