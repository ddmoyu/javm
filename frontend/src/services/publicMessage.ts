// 仅处理面向用户的提示，不修改请求身份、缓存键和原始资料。
export function publicMessage(message: string) {
  return message
    .replace(/https?:\/\/[^\s<>"'）。，；]*?(?:javbus|avwikidb)[^\s<>"'）。，；]*/gi, "远程地址")
    .replace(/\b(?:JavBus|AVWikiDB)\b/gi, "在线资料")
    .replace(/\bMetaTube\b/gi, "资料服务")
    .replace(/资料来源/g, "资料服务")
    .replace(/来源编号/g, "条目编号")
    .replace(/来源条目/g, "条目")
    .replace(/来源结果/g, "查询结果")
    .replace(/来源地址/g, "请求地址")
    .replace(/来源/g, "服务")
    .replace(/资料服务\s+服务/g, "资料服务");
}
