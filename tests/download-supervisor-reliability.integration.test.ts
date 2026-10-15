import { describe, expect, it } from "vite-plus/test";
import { spawn } from "node:child_process";
import { processCommand } from "../frontend/src/platform/neutralino/process";

describe.runIf(process.platform === "win32" && process.env.JAVM_DOWNLOAD_INTEGRATION === "1")(
  "真实下载监督进程取消",
  () => {
    it.each(["启动时", "运行中"])(
      "%s收到 EOF 后等待子进程退出，不遗留占用管道的进程",
      async (when) => {
        const script =
          'process.stdout.write("JAVM_CHILD="+process.pid+"\\n"); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),30000);';
        const [command, ...args] = processCommand(
          process.execPath,
          ["-e", script],
          process.pid,
          undefined,
          true,
        ).split(" ");
        const child = spawn(command!, args, { windowsHide: true, stdio: "pipe" });
        let output = "";
        let diagnostics = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString();
        });
        const closed = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        const deadline = performance.now() + 7000;
        try {
          if (when === "运行中") {
            while (!output.includes("JAVM_CHILD=")) {
              if (performance.now() >= deadline || child.exitCode !== null)
                throw new Error(`测试子进程未就绪: ${diagnostics}`);
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          const started = performance.now();
          child.stdin.end();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`取消超时: ${diagnostics}`)), 6000);
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
          expect(performance.now() - started).toBeLessThan(6000);
          const pid = Number(/JAVM_CHILD=(\d+)/.exec(output)?.[1]);
          expect(pid).toBeGreaterThan(0);
          expect(() => process.kill(pid, 0)).toThrow();
        } finally {
          const pid = Number(/JAVM_CHILD=(\d+)/.exec(output)?.[1]);
          if (pid) {
            try {
              process.kill(pid);
            } catch {
              /* 测试子进程已退出。 */
            }
          }
          if (child.exitCode === null) child.kill();
          await closed;
        }
      },
      15000,
    );
  },
);
