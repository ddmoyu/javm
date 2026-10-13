import { Observable } from "../metadata/shared";
export interface AvailableRelease {
  version: string;
  url: string;
}
export function newerVersion(a: string, b: string) {
  const aa = a.split("-")[0]!.split(".").map(Number),
    bb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! > bb[i]!;
  return !a.includes("-") && b.includes("-");
}
export type ReleasePlatform = "windows-x64" | "macos-x64" | "macos-arm64" | "linux-x64";
export function releasePlatform(os: string, arch: string): ReleasePlatform | undefined {
  if (os === "Windows" && arch === "x64") return "windows-x64";
  if (os === "Linux" && arch === "x64") return "linux-x64";
  if (os === "Darwin" && arch === "x64") return "macos-x64";
  // Neutralino 的 NL_ARCH 将 Apple Silicon 表示为 arm。
  if (os === "Darwin" && (arch === "arm" || arch === "arm64")) return "macos-arm64";
  return undefined;
}
export function compatibleRelease(
  raw: unknown,
  current: string,
  platform: ReleasePlatform = "windows-x64",
): AvailableRelease | null {
  if (!raw || typeof raw !== "object") throw new Error("官方发布信息格式无效。");
  const release = raw as {
    tag_name?: unknown;
    draft?: boolean;
    prerelease?: boolean;
    html_url?: unknown;
    assets?: { name?: unknown }[];
  };
  if (
    typeof release.tag_name !== "string" ||
    !/^v?\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(release.tag_name)
  )
    throw new Error("官方发布版本格式无效。");
  const version = release.tag_name.replace(/^v/, "");
  if (release.draft || release.prerelease || !newerVersion(version, current)) return null;
  const prefix = `JAVM-${version}-${platform}`;
  const suffixes =
    platform === "windows-x64"
      ? [".zip", "-portable.zip", "-setup.exe"]
      : platform.startsWith("macos-")
        ? [".dmg", "-portable.zip"]
        : [".deb", ".AppImage", "-portable.tar.gz"];
  if (
    !Array.isArray(release.assets) ||
    !release.assets.some(
      (asset) =>
        typeof asset.name === "string" &&
        (suffixes.some((suffix) => asset.name === prefix + suffix) ||
          (platform === "windows-x64" &&
            asset.name.startsWith(prefix + "-offline-") &&
            asset.name.endsWith(".zip"))),
    )
  )
    throw new Error("该发布尚未提供兼容当前系统与架构的安装包或便携包。");
  if (typeof release.html_url !== "string") throw new Error("发布页面地址无效。");
  const url = new URL(release.html_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith("/ddmoyu/javm/releases/tag/")
  )
    throw new Error("发布页面必须来自 JAVM 官方仓库。");
  return { version, url: url.href };
}
export class ApplicationUpdateService extends Observable<{
  available: boolean;
  busy: boolean;
  checked: boolean;
  error: string;
  release: AvailableRelease | null;
}> {
  private controller?: AbortController;
  private work?: Promise<void>;
  constructor(
    readonly current: string,
    private fetchRelease: (signal: AbortSignal) => Promise<unknown>,
    available: boolean,
    private platform: ReleasePlatform = "windows-x64",
  ) {
    super({ available, busy: false, checked: false, error: "", release: null });
  }
  async check() {
    if (!this.snapshot.available || this.snapshot.busy) return;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ busy: true, error: "" });
    const work = (async () => {
      try {
        const release = compatibleRelease(
          await this.fetchRelease(AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])),
          this.current,
          this.platform,
        );
        controller.signal.throwIfAborted();
        this.publish({ checked: true, release });
      } catch (e) {
        if (!controller.signal.aborted)
          this.publish({ error: e instanceof Error ? e.message : "更新检查失败" });
      } finally {
        this.publish({ busy: false });
      }
    })();
    this.work = work;
    await work;
  }
  async shutdown() {
    this.controller?.abort();
    await this.work;
  }
}
