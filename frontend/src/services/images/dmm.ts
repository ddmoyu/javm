// 番号直拼 DMM 官方 CDN 封面：cid = 字母前缀小写 + 尾部数字补零到 5 位。
// 仅覆盖 FANZA 体系；缺图时 CDN 302 到固定占位图，因此请求 DMM 图片时不跟随跳转。
export function dmmCid(code: string) {
  const match = /^(.*?)(\d+)$/.exec(code.replace(/\s+/g, ""));
  if (!match) return undefined;
  const label = match[1]!.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const number = Number.parseInt(match[2]!, 10);
  if (!/[a-z]/.test(label) || label.length > 32 || !Number.isSafeInteger(number)) return undefined;
  return `${label}${String(number).padStart(5, "0")}`;
}

/** digital 优先，其次 mono。 */
export function dmmCoverUrls(code: string) {
  const cid = dmmCid(code);
  return cid
    ? [
        `https://pics.dmm.co.jp/digital/video/${cid}/${cid}pl.jpg`,
        `https://pics.dmm.co.jp/mono/movie/adult/${cid}/${cid}pl.jpg`,
      ]
    : [];
}

export function isDmmImage(url: string) {
  try {
    return new URL(url).hostname === "pics.dmm.co.jp";
  } catch {
    return false;
  }
}
