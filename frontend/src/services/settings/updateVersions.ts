import type { UpdateChannel } from "../../contracts/updates";

export function parseVersion(value: string) {
  const match =
    /^(?:v)?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-(alpha|beta)\.(0|[1-9]\d{0,5}))?$/.exec(
      value,
    );
  return match
    ? {
        parts: [Number(match[1]), Number(match[2]), Number(match[3])],
        stage: match[4] ?? "stable",
        sequence: Number(match[5] ?? 0),
      }
    : null;
}
export function compareVersions(a: string, b: string) {
  const aa = parseVersion(a),
    bb = parseVersion(b);
  if (!aa || !bb) throw new Error("更新版本格式无效。");
  for (let i = 0; i < 3; i++) if (aa.parts[i] !== bb.parts[i]) return aa.parts[i]! - bb.parts[i]!;
  const rank = (stage: string) => (stage === "stable" ? 2 : stage === "beta" ? 1 : 0);
  return rank(aa.stage) - rank(bb.stage) || aa.sequence - bb.sequence;
}
export function acceptsVersion(version: string, channel: UpdateChannel) {
  const parsed = parseVersion(version);
  return !!parsed && (parsed.stage === "stable" || (channel === "beta" && parsed.stage === "beta"));
}
export const defaultUpdateChannel = (version: string): UpdateChannel =>
  parseVersion(version)?.stage === "beta" ? "beta" : "stable";
