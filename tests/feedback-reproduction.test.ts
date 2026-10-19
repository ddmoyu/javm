import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanLog,
  logEvent,
  redactText,
  setLogSink,
} from "../frontend/src/services/logging/events";
import { cleanReproduction } from "../frontend/src/services/logging/reproduction";
import { LogService } from "../frontend/src/services/logging/LogService";
import { RotatingLogStore } from "../frontend/src/services/logging/RotatingLogStore";
import {
  FeedbackService,
  restoreFeedbackState,
} from "../frontend/src/services/feedback/FeedbackService";
import type {
  FeedbackPort,
  FeedbackState,
} from "../frontend/src/services/feedback/FeedbackService";
import { formatReport } from "../frontend/src/services/feedback/report";
import { setFailureSink } from "../frontend/src/services/feedback/events";
import { reportDownloadFailure } from "../frontend/src/services/feedback/downloads";
import { createDownloadTasks, redactLog } from "../frontend/src/services/downloads/input";
import { OnlineWorksService } from "../frontend/src/services/catalog/OnlineWorksService";
import { OnlineActorSearchService } from "../frontend/src/services/catalog/OnlineActorSearchService";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";
import {
  MetadataQueryError,
  withMetadataTrace,
} from "../frontend/src/services/metadata/diagnostics";

const link = `https://media.example.invalid/DEMO-001.m3u8?token=fictional&signature=${"a".repeat(800)}&part=2`;
const services: FeedbackService[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-19T08:00:00Z");
});
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  setLogSink();
  setFailureSink();
  vi.useRealTimers();
});
function setup() {
  let saved: FeedbackState | null = null;
  const logs = new LogService();
  const port = {
    read: async () => null,
    write: async (state: FeedbackState) => {
      saved = structuredClone(state);
    },
    system: async () => ({ JAVM: "safe-test" }),
    copy: vi.fn(async (_text: string) => {}),
    open: vi.fn(async (_url: string) => {}),
  } satisfies FeedbackPort;
  const feedback = new FeedbackService(logs, port);
  services.push(feedback);
  setLogSink(logs.record);
  setFailureSink(feedback.capture);
  return { logs, feedback, port, saved: () => saved };
}

describe("反馈复现信息", () => {
  it("重复清理保留长业务链接及签名，仍隐藏凭据和用户名", () => {
    const value = cleanLog({
      level: "error",
      module: "catalog",
      event: "failed",
      message: `访问 ${link} 失败\nAuthorization: Bearer safe-secret\napi_key=standalone-secret`,
      context: { token: "context-secret", page: 2 },
      reproduction: {
        code: "DEMO-001",
        query: "安全样例",
        requestUrl: link,
        mediaUrl:
          "https://safe-user:private-password@media.example.invalid/safe.mp4?authorization=temporary",
        filePath: "D:\\Users\\Safe User\\videos\\DEMO-001.mp4",
      },
    });
    expect(cleanLog(value)).toEqual(value);
    expect(
      cleanReproduction({
        mediaUrl: " https://safe-user:private-password@media.example.invalid/safe.mp4 ",
      })?.mediaUrl,
    ).toBe("https://media.example.invalid/safe.mp4");
    expect(value.message).toContain(link);
    expect(value.reproduction?.requestUrl).toBe(link);
    expect(value.reproduction?.mediaUrl).toBe(
      "https://media.example.invalid/safe.mp4?authorization=temporary",
    );
    expect(value.reproduction?.filePath).toBe("D:\\Users\\[用户]\\videos\\DEMO-001.mp4");
    expect(JSON.stringify(value)).not.toMatch(
      /safe-secret|standalone-secret|context-secret|Safe User|safe-user|private-password/,
    );
    expect(redactText("socks5://safe-proxy:proxy-password@127.0.0.1:1080")).not.toContain(
      "proxy-password",
    );
  });

  it("日志到反馈、持久化恢复与复制均保留复现信息", async () => {
    const { feedback, port, saved } = setup();
    await feedback.initialize();
    logEvent(
      "error",
      "catalog",
      "works_failed",
      "读取超时",
      { page: 2 },
      {
        action: "online_works",
        query: "安全样例",
        code: "DEMO-001",
        page: 2,
        pageUrl: "https://source.example.invalid/DEMO-001",
        requestUrl: link,
      },
    );
    const report = feedback.getSnapshot().reports[0]!;
    await vi.advanceTimersByTimeAsync(3300);
    await feedback.submit(report.id, false);
    const restored = restoreFeedbackState(saved())!.reports[0]!;
    for (const text of [port.copy.mock.calls[0]![0], formatReport(restored)]) {
      expect(text).toContain("## 复现信息");
      expect(text).toContain("番号: DEMO-001");
      expect(text).toContain("请求页码: 2");
      expect(text).toContain(link);
    }
    expect(restored.before).toContain(link);
    expect(port.open).not.toHaveBeenCalled();
  });

  it("不同番号、查询、页码和地址不因同一句错误而合并", () => {
    const { feedback } = setup();
    const base = { module: "catalog", title: "读取失败", message: "读取超时" };
    const reproduction = { code: "DEMO-001", query: "样例甲", page: 1, requestUrl: link };
    const first = feedback.capture({ ...base, reproduction });
    feedback.capture({ ...base, reproduction: { ...reproduction } });
    for (const patch of [
      { code: "DEMO-002" },
      { query: "样例乙" },
      { page: 2 },
      { requestUrl: `${link}&page=2` },
    ])
      feedback.capture({ ...base, reproduction: { ...reproduction, ...patch } });
    expect(feedback.getSnapshot().reports).toHaveLength(5);
    expect(feedback.getSnapshot().reports.find((item) => item.id === first)?.count).toBe(2);
  });

  it("下载反馈保留番号、文件和地址，工具输出不再抹除业务地址", () => {
    const { feedback } = setup();
    const task = createDownloadTasks(
      {
        urls: [link],
        directory: "C:/Users/Safe User/videos",
        kind: "auto",
        headers: { Cookie: "session=private-cookie" },
      },
      [],
    )[0]!;
    task.code = "DEMO-001";
    task.error = "下载超时";
    reportDownloadFailure(task);
    const report = feedback.getSnapshot().reports[0]!;
    expect(report.reproduction).toMatchObject({ code: "DEMO-001", mediaUrl: link });
    expect(report.reproduction?.filePath).toContain("DEMO-001");
    expect(formatReport(report)).not.toContain("Safe User");
    const line = redactLog(`失败 ${link}\nsession=private-cookie`, task);
    expect(line).toContain(link);
    expect(line).not.toContain("private-cookie");
  });

  it("在线作品加载下一页失败保留实际页码、查询与请求地址", async () => {
    const { logs, feedback } = setup();
    const entity = {
      id: "safe-demo",
      name: "安全样例",
      url: "https://www.javbus.com/star/safe-demo",
    };
    const processor = {
      run: vi.fn(async (operation: string) => {
        if (operation === "javbusPlan")
          return { entities: [entity], queries: [], names: [entity.name] };
        if (operation === "javbusWorks") return { items: [], page: 1, nextPage: 2 };
        throw new Error("未预期的样例解析");
      }),
    } as unknown as CatalogProcessor;
    // 所有地址仅经过 mock，不请求真实网站。
    const fetch = vi
      .fn()
      .mockResolvedValueOnce("安全占位页面")
      .mockRejectedValueOnce(new Error("读取超时"));
    const works = new OnlineWorksService(processor, fetch, async () => {});
    works.select("actresses", entity.name);
    await vi.advanceTimersByTimeAsync(0);
    works.loadMore();
    await vi.advanceTimersByTimeAsync(0);
    const entry = logs.getRecentEntries().find((item) => item.event === "works_failed")!;
    expect(entry.context?.page).toBe(2);
    expect(entry.reproduction).toMatchObject({
      query: entity.name,
      page: 2,
      requestUrl: fetch.mock.calls[1]![0],
    });
    expect(feedback.getSnapshot().reports[0]?.reproduction?.page).toBe(2);
    expect(works.getSnapshot().page).toBe(1);
    await works.shutdown();
  });

  it("演员查询错误保留查询内容，嵌套资料查询保留最初复现对象", async () => {
    const { feedback } = setup();
    const actors = new OnlineActorSearchService({} as CatalogProcessor, async () => {
      throw new Error("读取超时");
    });
    actors.search("安全样例演员");
    await vi.advanceTimersByTimeAsync(0);
    expect(feedback.getSnapshot().reports[0]?.reproduction?.query).toBe("安全样例演员");
    await actors.shutdown();
    await expect(
      withMetadataTrace("search", undefined, undefined, (options) =>
        withMetadataTrace(
          "search",
          options,
          undefined,
          async () => {
            throw new MetadataQueryError(504, "资料超时", true);
          },
          { action: "metadata_search", query: "DEMO-001", source: "SafeSource" },
        ),
      ),
    ).rejects.toThrow("资料超时");
    expect(feedback.getSnapshot().reports[0]?.reproduction).toMatchObject({
      query: "DEMO-001",
      source: "SafeSource",
    });
  });

  it("完整长链接日志超过旧 12000 字符门槛时仍可从文件恢复", async () => {
    const files = new Map<string, string>();
    const store = new RotatingLogStore({
      directory: "safe-memory-only",
      list: async () =>
        [...files].map(([name, value]) => ({ name, size: new TextEncoder().encode(value).length })),
      append: async (name, text) => {
        files.set(name, (files.get(name) ?? "") + text);
      },
      remove: async (name) => {
        files.delete(name);
      },
      tail: async (name) => files.get(name) ?? "",
      openDirectory: async () => {},
    });
    const logs = new LogService(store);
    const long = `https://media.example.invalid/safe?signature=${"a".repeat(7800)}`;
    logs.record({
      level: "error",
      module: "playback",
      event: "failed",
      message: "读取失败",
      reproduction: { pageUrl: long, mediaUrl: long },
    });
    await logs.shutdown();
    expect([...files.values()][0]!.length).toBeGreaterThan(12000);
    expect((await store.recent())[0]?.reproduction?.mediaUrl).toBe(long);
  });

  it("复现字段有界，非法或超长地址明确标记且不能夹带请求头", () => {
    const clean = cleanReproduction({
      action: "scan",
      query: "a".repeat(1000),
      page: -1,
      requestUrl: `https://example.invalid/${"a".repeat(9000)}`,
      mediaUrl: "file:///safe.mp4",
      headers: { Cookie: "secret" },
      token: "secret",
      filePath: "/home/Safe User/videos/DEMO-001.mp4",
    });
    expect(clean?.requestUrl).toContain("超过 8192");
    expect(clean?.mediaUrl).toBe("[不支持的链接类型]");
    expect(clean?.query?.length).toBeLessThanOrEqual(501);
    expect(clean).not.toHaveProperty("headers");
    expect(clean).not.toHaveProperty("token");
    expect(clean).not.toHaveProperty("page");
    expect(clean?.filePath).toBe("/home/[用户]/videos/DEMO-001.mp4");
    expect(cleanReproduction(clean)).toEqual(clean);
  });
});
