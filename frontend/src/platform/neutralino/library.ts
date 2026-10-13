import { events, extensions, filesystem, server } from "@neutralinojs/lib";
import type { MediaDirectory } from "../../contracts/library";
import { LibraryService } from "../../services/library/LibraryService";
import { LibraryRequestTimeoutError } from "../../services/library/LibraryService";
import type { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import type { LibraryPort } from "../../services/library/LibraryService";
import type { Runtime } from "./bootstrap";
import { logEvent } from "../../services/logging/events";
import { LibraryMaintenanceService } from "../../services/library/LibraryMaintenanceService";
import { nativeSettingsStorage } from "./settingsStorage";
import type { AdRules } from "../../contracts/maintenance";
import { DirectoryWatchService } from "../../services/library/DirectoryWatchService";
import type { WatchEvent, WatchSettings } from "../../services/library/DirectoryWatchService";
import { LibraryDocumentsService } from "../../services/library/LibraryDocumentsService";
import { FileOrganizationService } from "../../services/library/FileOrganizationService";
import { normalizedPath, pathComparisonKey, pathRelativeTo } from "../../services/paths";

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
          reject(
            new LibraryRequestTimeoutError(
              "媒体库未响应，请先刷新查看状态；若仍无法连接，请重启桌面应用。",
            ),
          );
        },
        method.startsWith("library.scrape.") ||
          method.startsWith("library.maintenance.") ||
          method.startsWith("library.files.")
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
      const path = normalizedPath(directory.path);
      try {
        if (!(prefix in mounts)) await server.mount(prefix, directory.path);
        // Neutralino 返回正斜杠目录；Windows 原始路径不能直接与挂载记录比较。
        else if (pathComparisonKey(mounts[prefix]!) !== pathComparisonKey(path)) continue;
        available.push({ prefix, path });
      } catch {
        /* 离线目录仍显示已有资料，封面使用占位图。 */
      }
    }
    return (path: string) => {
      for (const root of available) {
        const relative = pathRelativeTo(path, root.path);
        if (relative !== undefined) {
          return `http://localhost:${window.NL_PORT}${root.prefix}/${relative.split("/").map(encodeURIComponent).join("/")}`;
        }
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
    if (port) {
      library.organization = new FileOrganizationService(
        port,
        {
          read: (path, offset, size) => filesystem.readBinaryFile(path, { pos: offset, size }),
          append: (path, bytes) => filesystem.appendBinaryFile(path, bytes),
        },
        () => library.refreshAfterImport(),
      );
      void library.organization.initialize();
      library.documents = new LibraryDocumentsService(
        port,
        {
          createDirectory: (path) => filesystem.createDirectory(path),
          async writeNew(path, content) {
            const temporary = `${path}.${crypto.randomUUID()}.tmp`;
            try {
              await filesystem.writeFile(temporary, content);
              await filesystem.copy(temporary, path, {
                overwrite: false,
                recursive: false,
                skip: false,
              });
            } finally {
              await filesystem.remove(temporary).catch(() => {});
            }
          },
          async readStream(path) {
            const stat = await filesystem.getStats(path);
            if (!stat.isFile || stat.size > 8192) throw new Error("STRM 不存在或超过 8 KiB。");
            return filesystem.readFile(path, { pos: 0, size: 8193 });
          },
        },
        () => library.refreshAfterImport(),
      );
      library.watcher = new DirectoryWatchService(
        library,
        {
          create: (path) => filesystem.createWatcher(path),
          online: async (path) => (await filesystem.getStats(path)).isDirectory,
          remove: (id) => filesystem.removeWatcher(id),
          listen: async (listener) => {
            const handler = (event: CustomEvent<WatchEvent>) => listener(event.detail);
            await events.on("watchFile", handler);
            return () => events.off("watchFile", handler);
          },
        },
        nativeSettingsStorage<WatchSettings>("library-watch-v1"),
        () => {
          const phase = library.maintenance?.getSnapshot().phase;
          return (
            library.backups?.getSnapshot().state === "running" ||
            phase === "reading" ||
            phase === "cleaning" ||
            !!library.organization?.getSnapshot().pending.length ||
            !!library.organization?.getSnapshot().busy
          );
        },
      );
      void library.watcher.initialize();
    }
    void service.initialize();
  }
  return service;
}
