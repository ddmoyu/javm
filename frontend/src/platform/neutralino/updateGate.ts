// 试运行期间可读取配置，但数据库、网络和子进程业务等待提交。
let release: (() => void) | undefined;
let gate = Promise.resolve();
export function holdUpdateStartup() {
  if (!release)
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
}
export function commitUpdateStartup() {
  release?.();
  release = undefined;
}
export function waitForUpdateStartup() {
  return gate;
}
