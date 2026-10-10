import { describe, expect, it, vi } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LibraryStatus } from "../frontend/src/contracts/library";
import { MediaHost } from "./helpers/mediaHost";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));

describe.runIf(enabled)("扫描并发自动计算", () => {
  it("以独立系统读数核对逻辑处理器，添加与重扫均忽略手动并发", async () => {
    const logicalProcessors = Number(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      ).trim(),
    );
    expect(logicalProcessors).toBeGreaterThan(0);
    const expected = Math.max(1, Math.min(logicalProcessors - 2, 16));
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(project, ".tmp/scan-concurrency-"));
    const directory = path.join(root, "合成空目录");
    await fs.mkdir(directory);
    const host = new MediaHost();
    try {
      await host.start(path.join(root, "downloads-v1.sqlite3"));
      expect(await host.request<LibraryStatus>("library.status")).toMatchObject({
        logicalProcessors,
        defaultConcurrency: expected,
        maxConcurrency: 16,
      });
      const added = await host.request<{ directoryId: string }>("library.add", {
        path: directory,
        recursive: true,
        formats: [],
        concurrency: 128,
      });
      const completed = async () => {
        await vi.waitFor(async () => {
          expect((await host.request<LibraryStatus>("library.status")).scan).toMatchObject({
            state: "completed",
            concurrency: expected,
          });
        });
      };
      await completed();
      await host.request("library.scan", { id: added.directoryId, concurrency: 1 });
      await completed();
    } finally {
      await host.close();
    }
  }, 20000);
});
