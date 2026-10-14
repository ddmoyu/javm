import { describe, expect, it, vi } from "vite-plus/test";
import { mergeMagnets, normalizeMagnet } from "../frontend/src/services/magnets/magnet";
import { parseMagnetPage } from "../frontend/src/services/magnets/parsers";
import { MagnetSearchService } from "../frontend/src/services/magnets/MagnetSearchService";
import { magnetLimits, magnetSearchUrl } from "../frontend/src/services/magnets/types";
import type {
  MagnetPage,
  MagnetResource,
  MagnetSourceId,
} from "../frontend/src/services/magnets/types";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

const hash = "01".repeat(20);
const base = "https://safe.example.invalid/search?q=SAFE-001&p=0&order=0";
const bytes = (html: string) => new TextEncoder().encode(html).buffer;
function row(value = hash, source: MagnetSourceId = "btdig"): MagnetResource {
  return {
    ...normalizeMagnet(`magnet:?xt=urn:btih:${value}&dn=SAFE-001`)!,
    title: "SAFE-001 云端花园",
    sources: [source],
  };
}
const empty: MagnetPage = { rows: [], hasMore: false };
const page = (value = row(), hasMore = false): MagnetPage => ({ rows: [value], hasMore });
function fixture(cooperative = true) {
  const jobs: {
    source: MagnetSourceId;
    query: string;
    page: number;
    signal: AbortSignal;
    finish(value: MagnetPage): void;
    fail(error: unknown): void;
  }[] = [];
  const open = vi.fn(async (_url: string) => {});
  const close = vi.fn();
  const service = new MagnetSearchService({
    merge: async (existing, incoming) => mergeMagnets(existing, incoming),
    search: (source, query, index, signal) =>
      new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (cooperative) signal.addEventListener("abort", abort, { once: true });
        jobs.push({
          source,
          query,
          page: index,
          signal,
          finish: (result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
          },
          fail: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
      }),
    open,
    close,
  });
  return { service, jobs, open, close };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const batch = (start: number, count: number, hasMore = true): MagnetPage => ({
  rows: Array.from({ length: count }, (_, index) =>
    row((start + index).toString(16).padStart(40, "0")),
  ),
  hasMore,
});

describe("磁力规范化与安全网页解析", () => {
  it("将 Base32 和十六进制 BTIH 归一，支持 v2，并拒绝空 hash 和非磁力协议", () => {
    const base32 = "AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIB";
    expect(normalizeMagnet(`magnet:?xt=urn:btih:${base32}`)?.id).toBe(`btih:${hash}`);
    expect(normalizeMagnet(`magnet:?xt=urn:btih:${hash.toUpperCase()}`)?.id).toBe(`btih:${hash}`);
    expect(normalizeMagnet(`magnet:?xt=urn:btmh:1220${"ab".repeat(32)}`)?.id).toBe(
      `btmh:1220${"ab".repeat(32)}`,
    );
    for (const raw of [
      "https://safe.example.invalid/file",
      "javascript:alert(1)",
      `magnet:?xt=urn:btih:${"0".repeat(40)}`,
      `magnet:?xt=urn:btih:${hash}\n`,
    ])
      expect(normalizeMagnet(raw)).toBeUndefined();
  });
  it("按内容去重并保留 tracker 与来源，标题相同而 hash 不同仍保留", () => {
    const a = {
      ...row(),
      magnet: row().magnet + "&tr=https%3A%2F%2Fsafe.example.invalid%2Fannounce",
    };
    const b = { ...row(hash, "btdirectory"), title: "同一虚构资源的另一个标题", sizeBytes: 1024 };
    const rows = mergeMagnets([a], [b, row("02".repeat(20))]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.sources).toEqual(["btdig", "btdirectory"]);
    expect(rows[0]?.seeders).toBeUndefined();
    expect(rows[0]?.sizeBytes).toBe(1024);
    expect(new URL(rows[0]!.magnet).searchParams.getAll("tr")).toEqual([
      "https://safe.example.invalid/announce",
    ]);
    expect(a.sizeBytes).toBeUndefined();
  });
  it("混合 v1/v2 能合并两种身份，矛盾的多个 BTIH 不被接受", () => {
    const v2 = `btmh:1220${"cd".repeat(32)}`;
    const second = { ...row(), ...normalizeMagnet(`magnet:?xt=urn:${v2}`)! };
    const hybrid = { ...row(), ...normalizeMagnet(`magnet:?xt=urn:btih:${hash}&xt=urn:${v2}`)! };
    expect(mergeMagnets([row(), second], [hybrid])).toHaveLength(1);
    expect(
      normalizeMagnet(`magnet:?xt=urn:btih:${hash}&xt=urn:btih:${"ab".repeat(20)}`),
    ).toBeUndefined();
  });
  it("只解析虚构 BTDig 行，恢复 HTML 实体、大小、文件数和安全分页", () => {
    const html = `<script>ignored()</script><div class='one_result extra'>
      <div class='torrent_name'><a href='/detail'>SAFE-001 云端 &amp; 花园</a></div>
      <span class='torrent_size'>1.5&nbsp;GB</span><span class='torrent_files'>12 files</span>
      <span class='torrent_age'>2 days ago</span>
      <a data-href='magnet:?xt=urn:btih:${"02".repeat(20)}'>忽略</a>
      <a href='magnet:?xt=urn:btih:${hash}&amp;dn=SAFE-001'>magnet</a></div>
      <a href='?q=SAFE-001&amp;p=1&amp;order=0'>下一页</a>`;
    const result = parseMagnetPage(bytes(html), base, "btdig");
    expect(result.rows[0]).toMatchObject({
      title: "SAFE-001 云端 & 花园",
      sizeBytes: 1.5 * 1024 ** 3,
      files: 12,
      id: `btih:${hash}`,
    });
    expect(result.hasMore).toBe(true);
    expect(result.rows[0]?.seeders).toBeUndefined();
    expect(
      parseMagnetPage(bytes(html.replaceAll("云端", "captcha 教程")), base, "btdig").rows,
    ).toHaveLength(1);
  });
  it("BT 目录仅从 hash 生成磁力，未知做种数保持未知", () => {
    const html = `<article class='item'><h4><span>1</span>SAFE-001 云端花园</h4>
      <a href='/hash/${hash}.html'>详情</a><p>Size：2 GB File Count：3 2026-01-01 10:00:00</p></article>`;
    const result = parseMagnetPage(bytes(html), base, "btdirectory");
    expect(result.rows[0]).toMatchObject({
      title: "SAFE-001 云端花园",
      sizeBytes: 2 * 1024 ** 3,
      files: 3,
    });
    expect(result.rows[0]?.seeders).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });
  it("区分空结果、验证页、未知页面结构和超大响应", () => {
    expect(parseMagnetPage(bytes("<p>0 results found</p>"), base, "btdig")).toEqual(empty);
    for (const html of [
      "<p>Verify you are human</p>",
      "<p>Changed layout</p>",
      "x".repeat(magnetLimits.bytes + 1),
    ])
      expect(() => parseMagnetPage(bytes(html), base, "btdig")).toThrow();
  });
  it("只编码非空关键词，不访问热门列表，不向未实现的分页发送请求", () => {
    const url = new URL(magnetSearchUrl("btdig", "SAFE-001 & 花园", 2));
    expect(url.searchParams.get("q")).toBe("SAFE-001 & 花园");
    expect(url.searchParams.get("p")).toBe("1");
    expect(() => magnetSearchUrl("btdig", " ", 1)).toThrow();
    expect(() => magnetSearchUrl("btdirectory", "SAFE-001", 2)).toThrow();
  });
});

describe("磁力搜索应用服务（全部使用 mock）", () => {
  it("首批补足20条：立即展示前10条，自动取第二页，之后仍可手动加载", async () => {
    const { service, jobs } = fixture();
    service.search("SAFE-001");
    jobs[0]!.finish(batch(1, 10));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(10);
    expect(service.getSnapshot().searching).toBe(true);
    expect(jobs[2]).toMatchObject({ source: "btdig", page: 2 });
    jobs[1]!.finish(empty);
    jobs[2]!.finish(batch(11, 10));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(20);
    expect(service.getSnapshot().searching).toBe(false);
    expect(jobs).toHaveLength(3);
    service.loadMore();
    expect(jobs[3]).toMatchObject({ source: "btdig", page: 3 });
    jobs[3]!.finish(batch(21, 10, false));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(30);
    await service.shutdown();
  });
  it("首批补足20条：重复项不计数，最多三页且不足时保留实际结果", async () => {
    const { service, jobs } = fixture();
    service.search("SAFE-001");
    jobs[0]!.finish(batch(1, 10));
    jobs[1]!.finish(empty);
    await settled();
    jobs[2]!.finish(batch(1, 10));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(10);
    expect(jobs[3]?.page).toBe(3);
    jobs[3]!.finish(batch(11, 5));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(15);
    expect(service.getSnapshot().searching).toBe(false);
    expect(service.getSnapshot().sources[0]?.hasMore).toBe(false);
    service.loadMore();
    expect(jobs).toHaveLength(4);
    await service.shutdown();
  });
  it("首批补足20条：第二页失败保留第一页，只重试失败页并在无下一页时停止", async () => {
    const { service, jobs } = fixture();
    service.search("SAFE-001");
    jobs[0]!.finish(batch(1, 10));
    jobs[1]!.finish(empty);
    await settled();
    jobs[2]!.fail(new ResolutionError("timeout"));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(10);
    expect(service.getSnapshot().sources[0]).toMatchObject({ state: "failed", page: 1 });
    service.retryFailed();
    expect(jobs[3]).toMatchObject({ source: "btdig", page: 2 });
    jobs[3]!.finish(batch(11, 8, false));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(18);
    expect(service.getSnapshot().searching).toBe(false);
    expect(jobs).toHaveLength(4);
    await service.shutdown();
  });
  it("首批补足20条：补页期间取消，保留已返回结果且不再自动请求", async () => {
    const { service, jobs } = fixture(false);
    service.search("SAFE-001");
    jobs[0]!.finish(batch(1, 10));
    jobs[1]!.finish(empty);
    await settled();
    service.cancel();
    expect(jobs[2]?.signal.aborted).toBe(true);
    jobs[2]!.finish(batch(11, 10));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(10);
    expect(service.getSnapshot().cancelled).toBe(true);
    expect(jobs).toHaveLength(3);
    await service.shutdown();
  });
  it("立即追加结果，单源失败不隐藏成功项，重试只请求失败来源", async () => {
    const { service, jobs } = fixture();
    service.search("SAFE-001");
    jobs[0]!.finish(page());
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(1);
    expect(service.getSnapshot().searching).toBe(true);
    jobs[1]!.fail(new ResolutionError("interaction_required"));
    await settled();
    expect(service.getSnapshot().sources[1]?.state).toBe("failed");
    service.retryFailed();
    expect(jobs).toHaveLength(3);
    expect(jobs[2]?.source).toBe("btdirectory");
    jobs[2]!.finish(page(row(hash, "btdirectory")));
    await settled();
    expect(service.getSnapshot().rows[0]?.sources).toHaveLength(2);
    await service.shutdown();
  });
  it("连续搜索最多占两项传输，旧查询的迟到结果不能覆盖新查询", async () => {
    const { service, jobs } = fixture(false);
    service.search("SAFE-OLD");
    service.search("SAFE-NEW");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.signal.aborted)).toBe(true);
    jobs[0]!.finish(page());
    jobs[1]!.finish(page());
    await settled();
    expect(jobs).toHaveLength(4);
    expect(service.getSnapshot().rows).toHaveLength(0);
    expect(jobs[2]?.query).toBe("SAFE-NEW");
    jobs[2]!.finish(page(row("02".repeat(20))));
    jobs[3]!.finish(page(row("03".repeat(20))));
    await settled();
    expect(service.getSnapshot().rows[0]?.id).toBe(`btih:${"02".repeat(20)}`);
    expect(service.getSnapshot().rows).toHaveLength(2);
    await service.shutdown();
  });
  it("取消后保留已找到的资源供复制，迟到结果丢弃", async () => {
    const { service, jobs } = fixture(false);
    service.search("SAFE-001");
    jobs[0]!.finish(page());
    await settled();
    service.cancel();
    expect(service.copyResult(`btih:${hash}`)).toContain("magnet:");
    jobs[1]!.finish(page(row("02".repeat(20))));
    await settled();
    expect(service.getSnapshot().rows).toHaveLength(1);
    expect(service.getSnapshot().cancelled).toBe(true);
    await service.shutdown();
  });
  it("分页最多三页，重复 hash 不增加结果数量", async () => {
    const { service, jobs } = fixture();
    service.search("SAFE-001");
    jobs[0]!.finish(page(row(), true));
    jobs[1]!.finish(empty);
    await settled();
    service.loadMore();
    expect(jobs[2]?.page).toBe(2);
    jobs[2]!.finish(page(row(), true));
    await settled();
    service.loadMore();
    expect(jobs[3]?.page).toBe(3);
    jobs[3]!.finish(page(row(), true));
    await settled();
    service.loadMore();
    expect(jobs).toHaveLength(4);
    expect(service.getSnapshot().rows).toHaveLength(1);
    await service.shutdown();
  });
  it("只在显式交接时调用外部下载器，失败允许重试且不伪装下载进度", async () => {
    const { service, jobs, open } = fixture();
    service.search("SAFE-001");
    jobs[0]!.finish(page());
    jobs[1]!.finish(empty);
    await settled();
    expect(open).not.toHaveBeenCalled();
    open.mockRejectedValueOnce(new Error("mock no handler"));
    await expect(service.openResult(`btih:${hash}`)).rejects.toThrow("外部下载器");
    expect(service.getSnapshot().sent).toHaveLength(0);
    await service.openResult(`btih:${hash}`);
    expect(open).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().sent).toEqual([`btih:${hash}`]);
    await service.shutdown();
  });
  it("旧查询清理失败保留重试所有权，并停止后续请求", async () => {
    const { service, jobs } = fixture(false);
    const retry = vi.fn(async () => {});
    service.search("SAFE-OLD");
    service.search("SAFE-NEW");
    jobs[0]!.fail(new StopUnconfirmedError(retry));
    jobs[1]!.finish(empty);
    await settled();
    expect(service.getSnapshot().cleanupPending).toBe(true);
    expect(jobs).toHaveLength(2);
    await service.retryCleanup();
    expect(retry).toHaveBeenCalledOnce();
    expect(service.getSnapshot().cleanupPending).toBe(false);
    await service.shutdown();
  });
  it("详情关闭会取消所属查询，StrictMode 重挂载和独立搜索不会误取消", async () => {
    const { service, jobs } = fixture();
    let release = service.holdView("SAFE-001");
    service.search("SAFE-001", true);
    release();
    release = service.holdView("SAFE-001");
    await settled();
    expect(jobs[0]?.signal.aborted).toBe(false);
    release();
    await settled();
    expect(jobs[0]?.signal.aborted).toBe(true);
    release = service.holdView("SAFE-001");
    service.search("SAFE-001");
    release();
    await settled();
    expect(jobs.at(-1)?.signal.aborted).toBe(false);
    await service.shutdown();
  });
});
