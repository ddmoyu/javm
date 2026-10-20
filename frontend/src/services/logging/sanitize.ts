// 业务地址用于复现，保留路径、查询参数和签名；HTTP 用户信息不属于业务身份。
export function diagnosticUrl(value: string) {
  if (value.length > 8192) return "[链接超过 8192 字符，未包含]";
  if (["[链接超过 8192 字符，未包含]", "[链接无效]", "[不支持的链接类型]"].includes(value))
    return value;
  const text = value.replace(/[\r\n\t]/g, "").trim();
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "[不支持的链接类型]";
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.href;
    }
    return text;
  } catch {
    return "[链接无效]";
  }
}

export function redactText(value: string, limit = 2000) {
  const text = value
    .slice(0, Math.max(16000, limit))
    // oxlint-disable-next-line no-control-regex -- 删除工具输出中的 ANSI 控制序列。
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, "[凭据已隐藏]")
    .replace(
      /((?:^|[\s{,])["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi,
      "$1[已隐藏]",
    )
    // 先处理完整的独立凭据，避免引号内的空格、转义或 URL 被分段后漏出。
    .replace(
      /((?:^|[\s{,;，；（(])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,"';}]+)/gi,
      "$1[已隐藏]",
    )
    .replace(/socks5h?:\/\/[^\s<>"']+/gi, "[代理地址已隐藏]")
    // oxlint-disable-next-line no-control-regex -- 保留换行和制表符，清理其他控制字符。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  // 分段处理，避免把业务 URL 的 token/signature 当成独立的设置密钥。
  const cleaned = text
    .split(/(https?:\/\/[^\s<>"']+)/gi)
    .map((part, index) =>
      index % 2
        ? diagnosticUrl(part)
        : part
            .replace(/(\b[A-Z]:[\\/]+Users[\\/]+)[^\\/\r\n"'<>]+/gi, "$1[用户]")
            .replace(/(\/(?:home|Users)\/)[^/\r\n"'<>]+/g, "$1[用户]"),
    )
    .join("");
  const end = /[\ud800-\udbff]/.test(cleaned[limit - 1] ?? "") ? limit - 1 : limit;
  return cleaned.length > end ? `${cleaned.slice(0, end)}…` : cleaned;
}
