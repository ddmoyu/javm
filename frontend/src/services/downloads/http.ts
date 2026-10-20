export interface HttpResumeInfo {
  status: number;
  validator: string;
  total: number;
}

// curl includes proxy CONNECT and redirect responses. Only the final response
// describes the downloaded representation; prefer a strong ETag over a date.
export function responseInfo(text: string): HttpResumeInfo {
  const block = text.split(/(?=^HTTP\/\S+ \d{3})/m).at(-1) || "";
  const headers = new Map(
    [...block.matchAll(/^([^:\r\n]+):[ \t]*(.*)$/gm)].map((entry) => [
      entry[1]!.toLowerCase(),
      entry[2]!.trim(),
    ]),
  );
  const etag = headers.get("etag") || "";
  const total =
    /\/(\d+)$/.exec(headers.get("content-range") || "")?.[1] ||
    headers.get("content-length") ||
    "0";
  return {
    status: Number(/^HTTP\/\S+ (\d{3})/.exec(block)?.[1] || 0),
    validator: etag && !/^W\//i.test(etag) ? etag : headers.get("last-modified") || "",
    total: Number(total),
  };
}
