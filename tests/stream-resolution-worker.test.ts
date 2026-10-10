import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ResolutionWorkerPool } from "../frontend/src/services/streamResolution/workerClient";
import type { ParseTasks } from "../frontend/src/services/streamResolution/ports";

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  send(value: unknown) {
    this.onmessage?.({ data: value } as MessageEvent);
  }
}
const pools: ResolutionWorkerPool[] = [];
function pool() {
  const workers: MockWorker[] = [];
  const value = new ResolutionWorkerPool(() => {
    const worker = new MockWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  pools.push(value);
  return { value, workers };
}
const input = (): ParseTasks["page"]["input"] => ({
  url: "https://demo.example.invalid/DEMO-001",
  provider: "static-page",
  body: new TextEncoder().encode("safe").buffer,
});
afterEach(() => {
  for (const value of pools.splice(0)) value.close();
  vi.useRealTimers();
});
describe("解析 Worker 生命周期", () => {
  it("并发上限 2、数据使用可转移 ArrayBuffer、完成后终止", async () => {
    const p = pool(),
      data = input();
    const first = p.value.run("page", data, new AbortController().signal);
    const second = p.value.run("page", input(), new AbortController().signal);
    const third = p.value.run("page", input(), new AbortController().signal);
    expect(p.workers).toHaveLength(2);
    p.workers[0]!.send({ ready: true });
    expect(p.workers[0]!.postMessage).toHaveBeenCalledWith({ operation: "page", input: data }, [
      data.body,
    ]);
    p.workers[0]!.send({ value: { candidates: [], next: [] } });
    await first;
    expect(p.workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(p.workers).toHaveLength(3);
    const cancelled = Promise.allSettled([second, third]);
    p.value.close();
    expect((await cancelled).every((result) => result.status === "rejected")).toBe(true);
  });
  it("取消终止所属 Worker，迟到回调不影响下一任务", async () => {
    const p = pool(),
      abort = new AbortController();
    const task = p.value.run("page", input(), abort.signal);
    const rejected = expect(task).rejects.toMatchObject({ code: "cancelled" });
    p.workers[0]!.send({ ready: true });
    const stale = p.workers[0]!.onmessage!;
    abort.abort();
    await rejected;
    stale({ data: { value: { candidates: ["late"], next: [] } } } as MessageEvent);
    expect(p.workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("启动和解析分别限时，超时只终止该任务", async () => {
    vi.useFakeTimers();
    const p = pool();
    const slow = p.value.run("page", input(), new AbortController().signal);
    const startup = p.value.run("page", input(), new AbortController().signal);
    const rejected = expect(slow).rejects.toMatchObject({ code: "limit_exceeded" });
    const startupRejected = expect(startup).rejects.toMatchObject({ code: "timeout" });
    p.workers[0]!.send({ ready: true });
    await vi.advanceTimersByTimeAsync(251);
    await rejected;
    expect(p.workers[1]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    await startupRejected;
  });
  it("排队取消不创建 Worker，关闭后拒绝新任务", async () => {
    const p = pool(),
      abort = new AbortController();
    const active = [
      p.value.run("page", input(), new AbortController().signal),
      p.value.run("page", input(), new AbortController().signal),
    ];
    const queue = p.value.run("page", input(), abort.signal);
    const rejected = expect(queue).rejects.toMatchObject({ code: "cancelled" });
    abort.abort();
    await rejected;
    expect(p.workers).toHaveLength(2);
    const done = Promise.allSettled(active);
    p.value.close();
    await done;
    await expect(p.value.run("page", input(), new AbortController().signal)).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});
