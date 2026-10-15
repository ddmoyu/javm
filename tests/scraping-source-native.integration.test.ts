import { describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort, ScrapeTarget } from "../frontend/src/services/scraping/ScrapeService";
import { MetadataPipeline } from "../frontend/src/services/scraping/MetadataPipeline";
import { MovieMetadataResolver } from "../frontend/src/services/metadata/MovieMetadataResolver";
import {
  MovieDetailsCache,
  movieCandidate,
} from "../frontend/src/services/metadata/MovieDetailsCache";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import type { NativeVideo } from "../frontend/src/contracts/library";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("资料来源后备与原生刮削衔接（隔离数据库、安全样例）", () => {
  it("旧来源离线时采用同番号目录资料，保存实际来源、封面和 NFO，重启后仍可读取", async () => {
    const workspace = path.resolve(".tmp");
    await fs.mkdir(workspace, { recursive: true });
    const root = await fs.mkdtemp(path.join(workspace, "scraping-source-native-"));
    const database = path.join(root, "downloads.sqlite3");
    const image = path.join(root, "safe-cover.png");
    await fs.writeFile(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    let host = new MediaHost();
    let service: ScrapeService | undefined;
    try {
      await host.start(database);
      const details: MovieDetails = {
        provider: "JavBus",
        id: "SAFE-990",
        homepage: "https://example.invalid/safe-990",
        coverUrl: "https://images.example.invalid/safe-cover.png",
        fields: {
          code: "SAFE-990",
          title: "安全合成自然纪录片",
          plot: "虚构的山水旅行介绍",
          studio: "虚构制作室",
          actors: ["虚构讲解员"],
          genres: ["自然"],
          premiered: "2026-01-01",
        },
      };
      const primary = {
        search: vi.fn(async () => []),
        details: vi.fn(async (): Promise<MovieDetails> => {
          throw new Error("安全模拟原来源离线");
        }),
      };
      const lookup = { available: true, read: vi.fn(async () => details) };
      const provider = new MetadataPipeline(
        new MovieMetadataResolver(primary, new MovieDetailsCache(), lookup),
        { read: async () => ({ fusion: false, retries: 0 }), write: async () => {} },
        true,
      );
      const port: ScrapePort = {
        load: (offset) => host.request("scraping.load", { offset }),
        save: (task, expectedRevision) => host.request("scraping.save", { task, expectedRevision }),
        remove: (task) => host.request("scraping.remove", { id: task.id, revision: task.revision }),
        prepare: async (task, signal) => {
          signal.throwIfAborted();
          const jobId = crypto.randomUUID();
          const target = await host.request<ScrapeTarget>("library.scrape.prepare", {
            jobId,
            workId: task.workId,
            candidate: task.candidate,
            collect: task.collect,
            path: task.path,
          });
          return { ...target, jobId };
        },
        artwork: async () => ({ path: image, dispose: async () => {} }),
        commit: (task, target, data, artwork) =>
          host.request("library.scrape.commit", {
            jobId: target.jobId ?? task.id,
            id: target.id,
            path: target.path,
            fileStamp: target.fileStamp,
            nfoStamp: target.nfoStamp ?? "",
            details: data,
            image: artwork,
          }),
        refresh: async () => {},
      };
      service = new ScrapeService(port, provider);
      const taskId = await service.enqueue({
        name: details.fields.title!,
        collect: true,
        candidate: { ...movieCandidate(details), provider: "OfflineFixture", id: "old-source" },
      });
      await vi.waitFor(() => expect(service!.getSnapshot().tasks[0]?.status).toBe("completed"), {
        timeout: 10000,
      });
      const task = service.getSnapshot().tasks[0]!;
      expect(task.candidate).toEqual(movieCandidate(details));
      const saved = await host.request<NativeVideo>("library.video", { id: task.workId });
      expect(saved).toMatchObject({
        title: details.fields.title,
        local_id: "SAFE-990",
        plot: details.fields.plot,
        studio: details.fields.studio,
        scan_status: 2,
      });
      expect(path.resolve(saved.nfo_path).startsWith(`${root}${path.sep}`)).toBe(true);
      expect(path.resolve(saved.poster!).startsWith(`${root}${path.sep}`)).toBe(true);
      const nfo = await fs.readFile(saved.nfo_path, "utf8");
      expect(nfo).toContain("JavBus:SAFE-990");
      expect(nfo).toContain(details.fields.plot);
      expect(await fs.readFile(saved.poster!)).toEqual(await fs.readFile(image));
      expect(lookup.read).toHaveBeenCalledTimes(1);
      expect(primary.search).not.toHaveBeenCalled();
      await service.shutdown();
      service = undefined;
      await host.close();
      host = new MediaHost();
      await host.start(database);
      const restored = await host.request<ScrapeTask[]>("scraping.load", { offset: 0 });
      expect(restored).toEqual([
        expect.objectContaining({
          id: taskId,
          status: "completed",
          candidate: movieCandidate(details),
        }),
      ]);
      expect(await host.request("library.video", { id: task.workId })).toMatchObject({
        title: details.fields.title,
        poster: saved.poster,
      });
    } finally {
      await service?.shutdown();
      await host.close();
    }
  }, 30000);
});
