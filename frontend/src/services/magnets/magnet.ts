import type { MagnetResource } from "./types";
import { magnetLimits } from "./types";

function appendTracker(params: URLSearchParams, tracker: string) {
  const candidate = new URLSearchParams(params);
  candidate.append("tr", tracker);
  if (candidate.toString().length <= 8184) params.append("tr", tracker);
}

function btih(value: string): string | undefined {
  if (/^[a-f\d]{40}$/i.test(value)) return value.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(value)) return;
  let bits = 0,
    buffer = 0,
    hex = "";
  for (const character of value.toUpperCase()) {
    buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((buffer >>> bits) & 255).toString(16).padStart(2, "0");
      buffer &= (1 << bits) - 1;
    }
  }
  return hex;
}

/** 仅接受内容标识和有限的展示、tracker 参数；不执行任意协议或远程脚本。 */
export function normalizeMagnet(raw: string) {
  // oxlint-disable-next-line no-control-regex -- 禁止协议链接中的控制字符。
  if (raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "magnet:" || url.pathname || url.host || url.hash) return;
  const hashes = new Map<string, string>();
  for (const xt of url.searchParams.getAll("xt")) {
    const match = /^urn:(btih|btmh):(.+)$/i.exec(xt);
    if (!match) continue;
    const family = match[1]!.toLowerCase();
    const hash =
      family === "btih"
        ? btih(match[2]!)
        : /^1220[a-f\d]{64}$/i.test(match[2]!)
          ? match[2]!.toLowerCase()
          : undefined;
    if (!hash || /^0+$/.test(hash) || (family === "btmh" && /^12200+$/.test(hash))) return;
    if (hashes.has(family) && hashes.get(family) !== hash) return;
    hashes.set(family, hash);
  }
  if (!hashes.size) return;
  const identities = [...hashes].map(([family, hash]) => `${family}:${hash}`).sort();
  const params = new URLSearchParams();
  for (const identity of identities) params.append("xt", `urn:${identity}`);
  const name = url.searchParams.get("dn");
  if (name) params.set("dn", name.replace(/\s+/g, " ").slice(0, 500));
  const size = Number(url.searchParams.get("xl"));
  if (Number.isSafeInteger(size) && size > 0) params.set("xl", String(size));
  const trackers = new Set<string>();
  for (const rawTracker of url.searchParams.getAll("tr").slice(0, 32)) {
    try {
      const tracker = new URL(rawTracker);
      if (
        rawTracker.length <= 1024 &&
        /^(https?|udp):$/.test(tracker.protocol) &&
        tracker.hostname &&
        !tracker.username &&
        !tracker.password &&
        trackers.size < 16
      )
        trackers.add(tracker.href);
    } catch {
      /* 畸形 tracker 不影响可用的内容标识。 */
    }
  }
  for (const tracker of trackers) appendTracker(params, tracker);
  return { id: identities[0]!, identities, magnet: `magnet:?${params}` };
}

/** 同一内容汇总来源；混合 v1/v2 磁力能连接两种身份，标题相同不作为去重证据。 */
export function mergeMagnets(
  existing: readonly MagnetResource[],
  incoming: readonly MagnetResource[],
) {
  const rows: MagnetResource[] = [];
  for (const input of [...existing, ...incoming]) {
    const normalized = normalizeMagnet(input.magnet);
    if (!normalized) continue;
    const matches = rows.filter((row) =>
      row.identities.some((id) => normalized.identities.includes(id)),
    );
    const first = matches[0];
    if (!first) {
      if (rows.length < magnetLimits.rows) rows.push({ ...input, ...normalized });
      continue;
    }
    const group = [...matches, { ...input, ...normalized }];
    const identities = [...new Set(group.flatMap((row) => row.identities))].sort();
    const params = new URLSearchParams();
    for (const identity of identities) params.append("xt", `urn:${identity}`);
    params.set("dn", first.title);
    for (const row of group)
      for (const tracker of new URL(row.magnet).searchParams.getAll("tr"))
        appendTracker(params, tracker);
    const combined = normalizeMagnet(`magnet:?${params}`);
    // 冲突的混合标识不能让两个不同内容合并。
    if (!combined) continue;
    const knownSeeds = group.flatMap((row) => (row.seeders === undefined ? [] : [row.seeders]));
    Object.assign(first, combined, {
      id: first.id,
      sources: [...new Set(group.flatMap((row) => row.sources))],
      sizeBytes: group.find((row) => row.sizeBytes !== undefined)?.sizeBytes,
      files: group.find((row) => row.files !== undefined)?.files,
      date: group.find((row) => row.date)?.date,
      seeders: knownSeeds.length ? Math.max(...knownSeeds) : undefined,
    });
    for (const duplicate of matches.slice(1)) rows.splice(rows.indexOf(duplicate), 1);
  }
  return rows;
}
