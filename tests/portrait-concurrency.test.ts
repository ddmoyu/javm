import { expect, it, vi } from "vite-plus/test";
import { PortraitService } from "../frontend/src/services/catalog/PortraitService";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";

const names = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `安全示例${prefix}${index}`);
const imageKey = (name: string) => `actresses:${name}`;

function fixture() {
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  let maximum = 0,
    hold = true;
  const run = vi.fn(async (_operation: string, payload: { names: string[] }) =>
    Object.fromEntries(
      payload.names.map((name) => [name, [`https://safe.example.invalid/${name}.jpg`]]),
    ),
  );
  const service = new PortraitService(
    { run: run as CatalogProcessor["run"], close: vi.fn() },
    {
      async load(_url, signal, key) {
        signal.throwIfAborted();
        started.push(key);
        if (hold)
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              signal.removeEventListener("abort", cancel);
              pending.delete(key);
              resolve();
            };
            const cancel = () => {
              pending.delete(key);
              reject(signal.reason);
            };
            pending.set(key, finish);
            maximum = Math.max(maximum, pending.size);
            signal.addEventListener("abort", cancel, { once: true });
          });
        return `safe:${key}`;
      },
      index: vi.fn(),
      shutdown: vi.fn(),
    },
  );
  return {
    service,
    run,
    started,
    pending,
    maximum: () => maximum,
    releaseAll() {
      hold = false;
      for (const finish of [...pending.values()]) finish();
    },
  };
}

it("六张头像并行，较快请求完成后立即开始下一张，不等待第一张慢图", async () => {
  const f = fixture();
  const batch = names("并行", 12);
  const progress = vi.fn();
  const task = f.service.load("actresses", batch, new AbortController().signal, progress);
  const settled = Promise.allSettled([task]);
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(6));
    f.pending.get(imageKey(batch[1]!))!();
    await vi.waitFor(() => expect(f.started).toHaveLength(7));
    expect(f.started[6]).toBe(imageKey(batch[6]!));
    expect(f.pending.has(imageKey(batch[0]!))).toBe(true);
    expect(f.pending.size).toBe(6);
    f.releaseAll();
    const result = await task;
    expect(Object.keys(result)).toHaveLength(12);
    expect(f.maximum()).toBe(6);
    expect(progress).toHaveBeenLastCalledWith(12, 12, result);
  } finally {
    await f.service.shutdown();
    await settled;
  }
});

it("两个头像批次共享六个名额，空位直接交给等待中的批次", async () => {
  const f = fixture();
  const firstNames = names("甲", 6),
    secondNames = names("乙", 6);
  const first = f.service.load("actresses", firstNames, new AbortController().signal);
  const second = f.service.load("actresses", secondNames, new AbortController().signal);
  const settled = Promise.allSettled([first, second]);
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(6));
    expect(f.run).toHaveBeenCalledTimes(2);
    f.pending.get(imageKey(firstNames[2]!))!();
    await vi.waitFor(() => expect(f.started).toHaveLength(7));
    expect(f.started[6]).toBe(imageKey(secondNames[0]!));
    expect(f.pending.size).toBe(6);
    f.releaseAll();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => Object.keys(result).length)).toEqual([6, 6]);
    expect(f.maximum()).toBe(6);
  } finally {
    await f.service.shutdown();
    await settled;
  }
});

it("取消排队头像立即结束该批次，不打断正在下载的批次，也不占用后续名额", async () => {
  const f = fixture();
  const firstNames = names("正在加载", 6),
    cancelledNames = names("已取消", 6),
    nextNames = names("新页面", 6);
  const first = f.service.load("actresses", firstNames, new AbortController().signal);
  const abort = new AbortController();
  const cancelled = f.service.load("actresses", cancelledNames, abort.signal);
  const settled = Promise.allSettled([first, cancelled]);
  let nextSettled: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(f.started).toHaveLength(6));
    abort.abort();
    await expect(cancelled).rejects.toThrow();
    expect(f.pending.size).toBe(6);
    const next = f.service.load("actresses", nextNames, new AbortController().signal);
    nextSettled = Promise.allSettled([next]);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(3));
    f.pending.get(imageKey(firstNames[3]!))!();
    await vi.waitFor(() => expect(f.started).toHaveLength(7));
    expect(f.started[6]).toBe(imageKey(nextNames[0]!));
    expect(f.started.some((key) => cancelledNames.map(imageKey).includes(key))).toBe(false);
    f.releaseAll();
    await Promise.all([first, next]);
    expect(f.maximum()).toBe(6);
  } finally {
    await f.service.shutdown();
    await settled;
    await nextSettled;
  }
});
