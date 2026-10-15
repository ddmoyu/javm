import { afterEach, expect, it, vi } from "vite-plus/test";
import { FeedbackBoundary } from "../frontend/src/features/feedback/FeedbackBoundary";
import { FeedbackService } from "../frontend/src/services/feedback/FeedbackService";
import { LogService } from "../frontend/src/services/logging/LogService";
vi.mock("../frontend/src/app/startup", () => ({ finishStartup: vi.fn() }));
afterEach(() => vi.useRealTimers());
it("界面边界始终打开自己的故障，其他后台报告与历史淘汰均不改变关联", async () => {
  vi.useFakeTimers();
  const service = new FeedbackService(new LogService(), {
    read: async () => null,
    write: async () => {},
    system: async () => ({}),
    copy: async () => {},
    open: async () => {},
  });
  try {
    await service.initialize();
    const boundary = new FeedbackBoundary({ children: null, service });
    boundary.componentDidCatch(new Error("安全界面渲染故障"), { componentStack: "SafeComponent" });
    const original = service.getSnapshot().reports[0]!.id;
    service.dismiss();
    service.capture({ module: "downloads", title: "其他故障", message: "另一个下载失败" });
    boundary.openFeedback();
    expect(service.getSnapshot().activeId).toBe(original);
    service.dismiss();
    for (let i = 0; i < 10; i++)
      service.capture({ module: "downloads", title: "后台故障", message: `下载失败 ${i}` });
    expect(service.getSnapshot().reports.some((item) => item.id === original)).toBe(false);
    boundary.openFeedback();
    const active = service
      .getSnapshot()
      .reports.find((item) => item.id === service.getSnapshot().activeId)!;
    expect(active.module).toBe("frontend");
    expect(active.message).toContain("安全界面渲染故障");
  } finally {
    service.dispose();
  }
});
