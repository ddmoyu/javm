import type { FacetQuery, FacetValue, PageRequest, QueryPage } from "../../contracts/library";
import type { GenreLane } from "./catalogData";
import type { AvwikiDimension } from "./avwikiCsv";
import type { AvwikiEntity, AvwikiWork, AvwikiWorksPage } from "./avwikiWorks";
import type { MovieDetails } from "../metadata/MetaTubeService";
import type {
  ActorDirectoryDimension,
  Additions,
  CrawlCursor,
  DiscoveryData,
  DiscoveryUpdate,
} from "./discoveryData";

interface Tasks {
  discoveryLoad: { input: { cache: string | null }; output: DiscoveryData };
  discoveryMerge: { input: { cache: string; update: DiscoveryUpdate }; output: DiscoveryData };
  listing: { input: { html: string; lane: GenreLane }; output: CrawlCursor };
  entities: { input: { html: string }; output: Additions };
  actorDirectory: {
    input: { html: string; dimension: ActorDirectoryDimension; page: number };
    output: { names: string[]; nextPage: number | null };
  };
  directory: {
    input: { html: string; dimension: AvwikiDimension; page: number };
    output: {
      names: string[];
      nextPage: number | null;
      portraits?: Record<string, string>;
      entries?: Record<string, string>;
    };
  };
  workEntities: {
    input: { name: string; dimension: AvwikiDimension };
    output: AvwikiEntity[];
  };
  works: {
    input: { html: string; entity: AvwikiEntity; page: number };
    output: AvwikiWorksPage;
  };
  workDetails: {
    input: { html: string; work: AvwikiWork };
    output: MovieDetails;
  };
  portraits: {
    input: { names: string[]; dimension: "actresses" | "maleActors"; fallback?: boolean };
    output: Record<string, string[]>;
  };
  portraitIndex: { input: { json: string }; output: boolean };
  query: {
    input: { names: string[]; query: FacetQuery; page: PageRequest };
    output: QueryPage<FacetValue>;
  };
}
export type CatalogRequest = {
  [K in keyof Tasks]: { id: number; operation: K; payload: Tasks[K]["input"] };
}[keyof Tasks];
export interface CatalogProcessor {
  run<K extends keyof Tasks>(operation: K, payload: Tasks[K]["input"]): Promise<Tasks[K]["output"]>;
  close(): void;
}
export class CatalogWorkerClient implements CatalogProcessor {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private fail(message: string) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error(message));
    }
    this.pending.clear();
  }
  run<K extends keyof Tasks>(
    operation: K,
    payload: Tasks[K]["input"],
  ): Promise<Tasks[K]["output"]> {
    if (this.pending.size >= 8) return Promise.reject(new Error("名单处理繁忙，请稍后重试。"));
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        this.worker = new Worker(new URL("./catalogWorker.ts", import.meta.url), {
          type: "module",
        });
        this.worker.onmessage = (
          event: MessageEvent<{ id: number; value: unknown; error?: string }>,
        ) => {
          const task = this.pending.get(event.data.id);
          if (!task) return;
          clearTimeout(task.timer);
          this.pending.delete(event.data.id);
          if (event.data.error) task.reject(new Error(event.data.error));
          else task.resolve(event.data.value);
        };
        this.worker.onerror = () => this.fail("名单后台处理失败，请重试。");
        this.worker.onmessageerror = () => this.fail("名单后台响应无效，请重试。");
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail("名单后台处理超时，请重试。"), 10_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as Tasks[K]["output"]),
        reject,
        timer,
      });
      try {
        this.worker.postMessage({ id, operation, payload });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("无法启动名单后台任务，请重试。"));
      }
    });
  }
  close() {
    this.fail("名单后台任务已停止。");
  }
}
