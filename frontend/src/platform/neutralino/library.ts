import { events, extensions, filesystem, server } from "@neutralinojs/lib";
import type { MediaDirectory } from "../../contracts/library";
import { LibraryService } from "../../services/library/LibraryService";
import type { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import type { LibraryPort } from "../../services/library/LibraryService";
import type { Runtime } from "./bootstrap";
import { logEvent } from "../../services/logging/events";
import { LibraryMaintenanceService } from "../../services/library/LibraryMaintenanceService";
import { nativeSettingsStorage } from "./settingsStorage";
import type { AdRules } from "../../contracts/maintenance";

export class NativeLibraryPort implements LibraryPort {
  private listening?: Promise<unknown>;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listener = (
    event: CustomEvent<{ requestId: string; ok: boolean; result?: unknown; error?: string }>,
  ) => {
    const reply = event.detail;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result);
    else {
      logEvent("error", "database", "request_failed", reply.error || "媒体库操作失败", {
        requestId: reply.requestId,
      });
      pending.reject(new Error(reply.error || "媒体库操作失败"));
    }
  };
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    this.listening ??= events.on("javm.database.response", this.listener);
    await this.listening;
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          logEvent("error", "database", "request_timeout", "媒体库请求超时", { method, requestId });
          reject(new Error("媒体库未响应，请先刷新查看状态；若仍无法连接，请重启桌面应用。"));
        },
        method.startsWith("library.scrape.") || method.startsWith("library.maintenance.")
          ? 90000
          : 20000,
      );
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      void extensions
        .dispatch("net.ddmoyu.javm.database", "javm.database.request", {
          requestId,
          protocol: 1,
          method,
          params,
        })
        .catch((error: unknown) => {
          if (!this.pending.delete(requestId)) return;
          clearTimeout(timer);
          reject(error);
        });
    });
  }
  async mount(directories: Pick<MediaDirectory, "id" | "path">[], metadataDirectory?: string) {
    const roots = [
      ...directories.map(({ id, path }) => ({ id, path })),
      ...(metadataDirectory ? [{ id: "metadata", path: metadataDirectory }] : []),
    ];
    const mounts = await server.getMounts();
    const retained = new Set(roots.map((directory) => `/javm-media/${directory.id}`));
    for (const prefix of Object.keys(mounts)) {
      if (!prefix.startsWith("/javm-media/") || retained.has(prefix)) continue;
      try {
        await server.unmount(prefix);
      } catch {
        // 下次刷新继续清理；挂载失败不应使已提交的目录删除在界面中复活。
      }
    }
    const available: { prefix: string; path: string }[] = [];
    for (const directory of roots) {
      const prefix = `/javm-media/${directory.id}`;
      try {
        if (!(prefix in mounts)) await server.mount(prefix, directory.path);
        else if (mounts[prefix] !== directory.path) continue;
        available.push({ prefix, path: directory.path.replaceAll("\\", "/").replace(/\/$/, "") });
      } catch {
        /* 离线目录仍显示已有资料，封面使用占位图。 */
      }
    }
    return (path: string) => {
      const normalized = path.replaceAll("\\", "/");
      for (const root of available)
        if (normalized.toLowerCase().startsWith(`${root.path.toLowerCase()}/`)) {
          const relative = normalized.slice(root.path.length + 1).split("/");
          if (relative.some((part) => part === "." || part === "..")) return undefined;
          return `http://localhost:${window.NL_PORT}${root.prefix}/${relative.map(encodeURIComponent).join("/")}`;
        }
      return undefined;
    };
  }
}
let service: LibraryService | undefined;
export function createLibraryService(runtime: Runtime, catalog?: DiscoveryCatalogService) {
  if (!service) {
    const port = runtime === "desktop" ? new NativeLibraryPort() : undefined;
    service = new LibraryService(port, catalog);
    const library = service;
    if (port)
      library.maintenance = new LibraryMaintenanceService(
        port,
        filesystem,
        nativeSettingsStorage<AdRules>("javm-ad-filter-v1"),
        () =>
          new Worker(new URL("../../services/library/maintenance.worker.ts", import.meta.url), {
            type: "module",
          }),
        () => library.refreshAfterImport(),
      );
    void service.initialize();
  }
  return service;
}
