// 首版只自动采用可明确提取的番号；片名及多个不同番号交给用户确认。
export function normalizeCode(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/^FC2[\s_-]*(?:PPV[\s_-]*)?/, "FC2-")
    .replace(/[\s_-]/g, "");
}
export function identifyCode(value: string): string | undefined {
  const input = value.normalize("NFKC").toUpperCase();
  const fc2Pattern = /(?:^|[^A-Z0-9])FC2[\s_-]*(?:PPV[\s_-]*)?(\d{5,9})(?=$|[^A-Z0-9])/g;
  const fc2 = [...input.matchAll(fc2Pattern)].map((m) => `FC2-${m[1]}`);
  const ordinary = [
    ...input
      .replace(fc2Pattern, " ")
      .matchAll(/(?:^|[^A-Z0-9])([A-Z]{2,12})[-_ ]?(\d{2,7})(?=$|[^A-Z0-9])/g),
  ]
    .filter((m) => !["MP", "H264", "H265", "HEVC", "XVID"].includes(m[1]!))
    .map((m) => `${m[1]}-${m[2]}`);
  const codes = [...new Set([...fc2, ...ordinary])];
  return codes.length === 1 ? codes[0] : undefined;
}
