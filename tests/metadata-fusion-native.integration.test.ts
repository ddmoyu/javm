import { describe, it, expect } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { fuseMetadata } from "../frontend/src/services/scraping/MetadataPipeline";
import type { ScrapeTarget } from "../frontend/src/services/scraping/ScrapeService";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("已有资料来源补全的原生落盘（安全虚构数据）", () => {
  it("保存补空字段及来源身份，拒绝伪造字段来源且保留原 NFO", async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/metadata-fusion-"));
    const host = new MediaHost();
    try {
      await host.start(path.join(root, "downloads.sqlite3"));
      await host.request("library.status");
      const candidate = {
        provider: "SafePrimary",
        id: "001",
        code: "SAFE-001",
        title: "安全主资料",
      };
      const details = fuseMetadata(
        {
          provider: candidate.provider,
          id: candidate.id,
          homepage: "https://safe.example.invalid/primary",
          fields: { code: candidate.code, title: candidate.title },
        },
        [
          {
            provider: "SafeSecondary",
            id: "002",
            homepage: "https://safe.example.invalid/secondary",
            fields: { code: candidate.code, title: "安全补充资料", studio: "虚构制作商" },
          },
        ],
      );
      const jobId = crypto.randomUUID();
      const target = await host.request<ScrapeTarget>("library.scrape.prepare", {
        jobId,
        candidate,
      });
      const saved = await host.request<{ nfoPath: string }>("library.scrape.commit", {
        ...target,
        jobId,
        details,
      });
      const nfo = await fs.readFile(saved.nfoPath, "utf8");
      expect(nfo).toContain("SafePrimary:001");
      expect(nfo).toContain("SafeSecondary:002");
      expect(await host.request("library.video", { id: target.id })).toMatchObject({
        title: candidate.title,
        studio: "虚构制作商",
      });
      const database = new DatabaseSync(path.join(root, "library.sqlite3"), { readOnly: true });
      try {
        const row = database.prepare("SELECT provenance FROM works WHERE id=?").get(target.id)!;
        const provenance = JSON.parse(String(row.provenance));
        expect(provenance._fusion.fields.studio).toEqual({ provider: "SafeSecondary", id: "002" });
      } finally {
        database.close();
      }
      const nextJob = crypto.randomUUID();
      const next = await host.request<ScrapeTarget>("library.scrape.prepare", {
        jobId: nextJob,
        workId: target.id,
      });
      await expect(
        host.request("library.scrape.commit", {
          ...next,
          jobId: nextJob,
          details: {
            ...details,
            fusion: {
              ...details.fusion,
              fields: { studio: { provider: "Unknown", id: "untrusted" } },
            },
          },
        }),
      ).rejects.toThrow("字段来源");
      expect(await fs.readFile(saved.nfoPath, "utf8")).toBe(nfo);
    } finally {
      await host.close();
    }
  }, 30000);
});
