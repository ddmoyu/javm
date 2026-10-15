import type { UpdateChannel } from "../../contracts/updates";
import { acceptsVersion, compareVersions, parseVersion } from "./updateVersions";

export interface UpdateRelease {
  version: string;
  url: string;
  notes: string;
}
export function updateReleases(
  raw: unknown,
  current: string,
  channel: UpdateChannel,
): UpdateRelease[] {
  if (!Array.isArray(raw)) throw new Error("官方发布信息格式无效。");
  return raw
    .flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const item = value as {
        tag_name?: unknown;
        draft?: unknown;
        prerelease?: unknown;
        assets?: { name?: unknown }[];
        body?: unknown;
      };
      if (typeof item.tag_name !== "string" || !item.tag_name.startsWith("v") || item.draft)
        return [];
      const version = item.tag_name.slice(1),
        parsed = parseVersion(version);
      if (!parsed || !acceptsVersion(version, channel) || compareVersions(version, current) <= 0)
        return [];
      if (
        (parsed.stage === "stable" && item.prerelease) ||
        (parsed.stage === "beta" && !item.prerelease)
      )
        return [];
      if (
        !Array.isArray(item.assets) ||
        !item.assets.some((asset) => asset.name === "JAVM-update.json")
      )
        return [];
      return [
        {
          version,
          url: `https://github.com/ddmoyu/javm/releases/tag/v${version}`,
          notes: typeof item.body === "string" ? item.body.slice(0, 12000) : "",
        },
      ];
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}
