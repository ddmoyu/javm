import type { LibraryPort } from "./LibraryService";
import { Observable, serviceError } from "../metadata/shared";
import { logEvent } from "../logging/events";
export interface FileOperation {
  id: string;
  media_id: string;
  source: string;
  target: string;
  temporary: string;
  size: number;
  verified: number;
  written?: number;
  state: "copying" | "ready" | "committed" | "done" | "aborted";
}
export interface RelinkCandidate {
  id: string;
  path: string;
  target: string;
  matched: boolean;
}
export interface FileChunks {
  read(path: string, offset: number, size: number): Promise<ArrayBuffer>;
  append(path: string, bytes: ArrayBuffer): Promise<void>;
}
export class FileOrganizationService extends Observable<{
  busy: boolean;
  action: string;
  progress: number;
  error: string;
  pending: FileOperation[];
  candidates: RelinkCandidate[];
  candidateRoots: { oldRoot: string; newRoot: string } | null;
  nextCandidate: string;
}> {
  private active?: { abort: AbortController; done: Promise<void> };
  private stopped = false;
  constructor(
    private port: Pick<LibraryPort, "request">,
    private files: FileChunks,
    private refresh: () => Promise<void>,
  ) {
    super({
      busy: false,
      action: "",
      progress: 0,
      error: "",
      pending: [],
      candidates: [],
      candidateRoots: null,
      nextCandidate: "",
    });
  }
  async initialize() {
    try {
      this.publish({ pending: await this.port.request<FileOperation[]>("library.files.list") });
    } catch (error) {
      this.publish({ error: serviceError(error) });
    }
  }
  private run(action: string, work: (signal: AbortSignal) => Promise<void>) {
    if (this.stopped || this.active) return Promise.reject(new Error("请等待当前文件任务结束。"));
    const abort = new AbortController();
    this.publish({ busy: true, action, progress: 0, error: "" });
    const done = Promise.resolve()
      .then(() => work(abort.signal))
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          logEvent("error", "library", "file_operation_failed", serviceError(error), { action });
        this.publish({
          error: abort.signal.aborted ? "已暂停，文件与恢复记录已保留。" : serviceError(error),
        });
        throw error;
      })
      .finally(async () => {
        await this.initialize();
        await this.refresh().catch(() => {});
        this.active = undefined;
        this.publish({ busy: false });
      });
    this.active = { abort, done };
    return done;
  }
  private async copy(operation: FileOperation, signal: AbortSignal) {
    let lastProgress = 0;
    if (operation.state === "copying") {
      let current = await this.port.request<FileOperation>("library.files.inspect", {
        id: operation.id,
      });
      while (current.verified < current.size) {
        signal.throwIfAborted();
        if (current.verified === current.written) {
          // The official filesystem API copies bounded chunks; conversion never holds a whole video in memory.
          const size = Math.min(256 * 1024, current.size - current.verified);
          const bytes = await this.files.read(current.source, current.verified, size);
          signal.throwIfAborted();
          if (bytes.byteLength !== size) throw new Error("源文件读取不完整，已保留当前进度。");
          await this.files.append(current.temporary, bytes);
        }
        current = await this.port.request<FileOperation>("library.files.verify", {
          id: current.id,
        });
        const now = performance.now();
        if (now - lastProgress >= 200 || current.verified === current.size) {
          this.publish({ progress: current.size ? (current.verified / current.size) * 100 : 100 });
          lastProgress = now;
        }
      }
    }
    signal.throwIfAborted();
    this.publish({ action: "提交目标并清理原件" });
    await this.port.request("library.files.commit", { id: operation.id });
    this.publish({ progress: 100 });
  }
  move(mediaId: string, target: string) {
    return this.run("复制并核对文件", async (signal) => {
      const operation = await this.port.request<FileOperation>("library.files.prepare", {
        mediaId,
        target,
      });
      signal.throwIfAborted();
      await this.copy(operation, signal);
    });
  }
  resume(operation: FileOperation) {
    return this.run("恢复文件整理", (signal) => this.copy(operation, signal));
  }
  renameDownloaded(source: string, target: string, operationId: string) {
    return this.run("更新下载文件名", async (signal) => {
      const operation = await this.port.request<FileOperation>("library.files.prepare", {
        source,
        target,
        operationId,
        rename: true,
      });
      await this.copy(operation, signal);
    });
  }
  discard(operation: FileOperation) {
    return this.run("取消未完成复制", async () => {
      await this.port.request("library.files.abort", { id: operation.id });
    });
  }
  preview(oldRoot: string, newRoot: string, after = "") {
    return this.run("检查新的资源路径", async (signal) => {
      const candidates = await this.port.request<RelinkCandidate[]>("library.files.relinkPreview", {
        oldRoot,
        newRoot,
        after,
      });
      signal.throwIfAborted();
      this.publish({
        candidates,
        candidateRoots: { oldRoot, newRoot },
        nextCandidate: candidates.length === 500 ? candidates.at(-1)!.id : "",
      });
    });
  }
  relink(candidates: RelinkCandidate[]) {
    return this.run("重新关联资源", async (signal) => {
      if (candidates.length > 500) throw new Error("每批最多关联 500 个文件。");
      for (const [index, item] of candidates.entries()) {
        signal.throwIfAborted();
        if (!item.matched) continue;
        await this.port.request("library.files.relink", { id: item.id, target: item.target });
        this.publish({ progress: ((index + 1) / candidates.length) * 100 });
      }
      this.publish({ candidates: [] });
    });
  }
  cancel = () => this.active?.abort.abort();
  async shutdown() {
    this.stopped = true;
    this.cancel();
    await this.active?.done.catch(() => {});
  }
}
