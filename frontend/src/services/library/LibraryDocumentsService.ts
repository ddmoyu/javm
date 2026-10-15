import type { LibraryPort } from "./LibraryService";
import { Observable, serviceError } from "../metadata/shared";
import { identifyCode } from "../scraping/identity";
import { webUrl } from "../streamResolution/shared";

export interface DocumentFiles {
  createDirectory(path: string): Promise<unknown>;
  writeNew(path: string, text: string): Promise<void>;
  readStream(path: string): Promise<string>;
}
interface DocumentSnapshot {
  running: boolean;
  mode: string;
  processed: number;
  succeeded: number;
  failed: number;
  directory: string;
  error: string;
  failures: string[];
  cancelled: boolean;
}
export function parseStrm(content: string) {
  if (new TextEncoder().encode(content).byteLength > 8192) throw new Error("STRM 超过 8 KiB。");
  const url = content.replace(/^\uFEFF/, "").trim();
  webUrl(url);
  if (/\s/.test(url)) throw new Error("STRM 必须只包含一行 HTTP/HTTPS 地址。");
  return url;
}
const safePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "work";
export class LibraryDocumentsService extends Observable<DocumentSnapshot> {
  private running?: Promise<void>;
  private cancelled = false;
  private stopped = false;
  constructor(
    private port: Pick<LibraryPort, "request">,
    private files: DocumentFiles,
    private refresh: () => Promise<void>,
  ) {
    super({
      running: false,
      mode: "",
      processed: 0,
      succeeded: 0,
      failed: 0,
      directory: "",
      error: "",
      failures: [],
      cancelled: false,
    });
  }
  private run(mode: string, operation: () => Promise<void>) {
    if (this.stopped || this.running)
      return Promise.reject(new Error("请等待当前资料文件任务结束。"));
    this.cancelled = false;
    this.publish({
      running: true,
      mode,
      processed: 0,
      succeeded: 0,
      failed: 0,
      error: "",
      failures: [],
      directory: "",
      cancelled: false,
    });
    const pending = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        this.publish({ error: serviceError(error) });
        throw error;
      })
      .finally(async () => {
        await this.refresh().catch(() => {});
        this.running = undefined;
        this.publish({ running: false, cancelled: this.cancelled });
      });
    this.running = pending;
    return pending;
  }
  private record(error?: unknown) {
    this.publish({
      processed: this.snapshot.processed + 1,
      succeeded: this.snapshot.succeeded + Number(!error),
      failed: this.snapshot.failed + Number(!!error),
      failures: error
        ? [...this.snapshot.failures, serviceError(error)].slice(0, 20)
        : this.snapshot.failures,
    });
  }
  exportNfo(root: string, id?: string) {
    return this.run("导出 NFO", async () => {
      const directory = `${root.replace(/[\\/]$/, "")}/JAVM-export-${crypto.randomUUID()}`;
      await this.files.createDirectory(directory);
      this.publish({ directory });
      let after = "",
        seen = 0;
      while (!this.cancelled) {
        const page = id
          ? [{ id }]
          : await this.port.request<{ id: string }[]>("library.documents.list", { after });
        if (page.length > 100 || (seen += page.length) > 10_000)
          throw new Error("每次最多导出 1 万部作品，请分批导出。");
        for (const work of page) {
          if (this.cancelled) break;
          try {
            if (await this.exportOne(directory, work.id)) this.record();
          } catch (error) {
            this.record(error);
          }
        }
        if (id || page.length < 100) break;
        const next = page.at(-1)!.id;
        if (next <= after) throw new Error("导出分页已失效，请重试。");
        after = next;
      }
    });
  }
  private async exportOne(directory: string, id: string, url?: string) {
    const data = await this.port.request<{ id: string; code: string; content: string }>(
      "library.documents.nfo",
      { id },
    );
    if (this.cancelled) return false;
    const folder = `${directory}/${safePart(data.code)}-${safePart(data.id)}`;
    await this.files.createDirectory(folder);
    await this.files.writeNew(`${folder}/movie.nfo`, data.content);
    if (url) {
      if (this.cancelled) return false;
      await this.files.writeNew(`${folder}/movie.strm`, `${url}\n`);
    }
    return true;
  }
  exportStream(id: string, root: string, address: string) {
    return this.run("导出 STRM 与 NFO", async () => {
      const url = webUrl(address),
        directory = `${root.replace(/[\\/]$/, "")}/JAVM-export-${crypto.randomUUID()}`;
      await this.files.createDirectory(directory);
      this.publish({ directory });
      if (await this.exportOne(directory, id, url)) this.record();
    });
  }
  importStreams(paths: string[]) {
    return this.run("导入 STRM", async () => {
      if (!paths.length || paths.length > 200) throw new Error("每次请选择 1～200 个 STRM 文件。");
      for (const path of [...new Set(paths)]) {
        if (this.cancelled) break;
        try {
          if (!/\.strm$/i.test(path)) throw new Error("仅导入 .strm 文件。");
          const content = await this.files.readStream(path),
            url = parseStrm(content);
          if (this.cancelled) break;
          await this.port.request("library.documents.importStream", {
            path,
            content,
            url,
            code: identifyCode(path.split(/[\\/]/).at(-1) ?? "") ?? "",
          });
          this.record();
        } catch (error) {
          this.record(new Error(`${path}：${serviceError(error)}`));
        }
      }
    });
  }
  cancel = () => {
    this.cancelled = true;
    this.publish({ cancelled: true });
  };
  async shutdown() {
    this.stopped = true;
    this.cancel();
    await this.running?.catch(() => {});
  }
}
