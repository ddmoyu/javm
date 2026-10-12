import { Observable } from "../metadata/shared";
export interface AvailableRelease {
  version: string;
  url: string;
}
export function newerVersion(a: string, b: string) {
  const [aCore, aPreview] = a.split("-"),
    [bCore, bPreview] = b.split("-");
  const aa = aCore!.split(".").map(Number),
    bb = bCore!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! > bb[i]!;
  return !aPreview && Boolean(bPreview);
}
export function compatibleRelease(raw: unknown, current: string): AvailableRelease | null {
  if (!raw || typeof raw !== "object") throw new Error("官方发布信息格式无效。");
  const release = raw as {
    tag_name?: unknown;
    draft?: boolean;
    prerelease?: boolean;
    html_url?: unknown;
    assets?: { name?: unknown }[];
  };
  if (release.draft || release.prerelease) return null;
  if (
    typeof release.tag_name !== "string" ||
    !/^v?\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(release.tag_name)
  )
    throw new Error("官方发布版本格式无效。");
  const version = release.tag_name.replace(/^v/, "");
  if (!newerVersion(version, current)) return null;
  if (
    !Array.isArray(release.assets) ||
    !release.assets.some(
      (asset) =>
        typeof asset.name === "string" &&
        asset.name.startsWith(`JAVM-${version}-windows-x64-offline-`) &&
        asset.name.endsWith(".zip"),
    )
  )
    throw new Error("该发布尚未提供兼容当前架构的 Windows 离线包。");
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
