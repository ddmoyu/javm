import { describe, expect, it, vi } from "vite-plus/test";
import { inspectChallengeInteraction } from "../frontend/src/services/catalog/challengeInteraction";

function browser() {
  return {
    send: vi.fn(async (method: string): Promise<Record<string, unknown>> => {
      if (method === "Runtime.evaluate") return { result: { value: true } };
      if (method === "Accessibility.getFullAXTree")
        return { nodes: [{ ignored: false, role: { value: "checkbox" }, backendDOMNodeId: 7 }] };
      if (method === "DOM.resolveNode") return { object: { objectId: "safe-node" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: true } };
      return {};
    }),
  };
}

describe("验证控件只读识别（安全 mock）", () => {
  it("识别后释放远程对象，不发送点击、聚焦或页面修改命令", async () => {
    const cdp = browser();
    expect(await inspectChallengeInteraction(cdp, "frame", new AbortController().signal)).toBe(
      "required",
    );
    expect(cdp.send.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Accessibility.getFullAXTree",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ]);
  });
  it("非验证来源不读取无障碍树；协议不可用只返回未知", async () => {
    const cdp = browser();
    cdp.send.mockResolvedValueOnce({ result: { value: false } });
    expect(await inspectChallengeInteraction(cdp, "frame", new AbortController().signal)).toBe(
      "none",
    );
    expect(cdp.send).toHaveBeenCalledTimes(1);
    cdp.send.mockRejectedValueOnce(new Error("Safe unsupported protocol"));
    expect(await inspectChallengeInteraction(cdp, "frame", new AbortController().signal)).toBe(
      "unavailable",
    );
  });
  it("取消后不再查询、操作或释放已随宿主关闭的对象", async () => {
    const cdp = browser(),
      abort = new AbortController();
    cdp.send.mockImplementationOnce(async () => {
      abort.abort();
      return { result: { value: true } };
    });
    expect(await inspectChallengeInteraction(cdp, "frame", abort.signal)).toBe("unavailable");
    expect(cdp.send).toHaveBeenCalledTimes(1);
  });
});
