import { ResolutionError, webUrl } from "./shared";

export interface ResourceSource {
  id: string;
  name: string;
  template: string;
  failRule?: { selector: string; text: string };
}
// 迁移旧版的定位模板，不自动探测网站。开发和验证仅注入本地安全来源。
// 2026-10-12 经用户授权，在全程隐藏的实例中逐个真实验证：以下来源取得并通过检查的完整时长 HLS。
// 网站随时可能变更，scripts/test-resource-sources.mjs 可重新验证；验证记录见 ADR 0010。
export const resourceSources: readonly ResourceSource[] = [
  { id: "missav", name: "MissAV", template: "https://missav.ws/{code}" },
  {
    id: "thisav",
    name: "ThisAV",
    template: "https://thisav2.com/cn/{code}",
    failRule: { selector: "h1", text: "找不到页面" },
  },
  { id: "jable", name: "Jable.tv", template: "https://jable.tv/videos/{code}/" },
  {
    id: "jptt",
    name: "JPTT.tv",
    template: "https://jptt.tv/video/{code}",
    failRule: { selector: "h1", text: "404 Not Found" },
  },
  {
    id: "123av",
    name: "123AV",
    template: "https://123av.com/en/v/{code}",
    failRule: { selector: ".errpage__code", text: "404" },
  },
  {
    id: "javgg",
    name: "JavGG",
    template: "https://javgg.net/jav/{code}/",
    failRule: { selector: ".no-result", text: "404" },
  },
  {
    id: "javfull",
    name: "JavFull",
    template: "https://javfull.net/{code}/",
    failRule: { selector: "#notfound", text: "" },
  },
];
/**
 * 同日验证未取得正片的旧版来源，不参与自动查找，避免每次空耗隐藏实例期限：
 * njav 仅加载广告流；javsb 改为带标题的地址；myjav 番号地址均 404；
 * javct 默认播放器只提供预告；javmost 未出现清单；javeng 源站 523。
 */
export const unverifiedResourceSources: readonly ResourceSource[] = [
  {
    id: "njav",
    name: "NJAV",
    template: "https://www.njav.com/zh/xvideos/{code}",
    failRule: { selector: ".message", text: "404 Not Found" },
  },
  {
    id: "javsb",
    name: "Jav.sb",
    template: "https://jav.sb/jav/{code}-1-1.html",
    failRule: { selector: ".badge", text: "404" },
  },
  {
    id: "myjav",
    name: "MyJav.tv",
    template: "https://cn.myjav.tv/video/{code}",
    failRule: { selector: "h1", text: "404" },
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
