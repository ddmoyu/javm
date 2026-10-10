// await Promise.resolve() 仍在同一个微任务周期中，不能让输入与绘制获得执行机会。
export function yieldToUi(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } })
    .scheduler;
  return scheduler ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}
