import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 只有合成文本和临时标记，无媒体、网络或用户目录访问。
const [mode, marker, ...args] = process.argv.slice(2);
const lifetime = setTimeout(() => process.exit(0), 15000);
if (mode === "echo") {
  clearTimeout(lifetime);
  process.stdout.write(
    JSON.stringify({
      args,
      inherited: process.env.JAVM_SAFE_INHERITED,
      override: process.env.JAVM_SAFE_OVERRIDE,
      empty: process.env.JAVM_SAFE_EMPTY,
    }),
  );
  process.stderr.write("safe stderr\n");
  process.exitCode = 23;
} else if (mode === "leaf") {
  process.on("SIGTERM", () => {});
  writeFileSync(marker, String(process.pid));
} else if (mode === "tree" || mode === "natural") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "leaf", `${marker}.leaf`],
    { stdio: "inherit" },
  );
  process.on("SIGTERM", () => {});
  writeFileSync(marker, JSON.stringify({ leader: process.pid, descendant: child.pid }));
  if (mode === "natural") setTimeout(() => process.exit(7), 800);
} else if (mode === "flood") {
  writeFileSync(marker, String(process.pid));
  process.on("SIGTERM", () => {});
  const buffer = Buffer.alloc(65536, 120);
  // 同步阻塞子进程输出，监督器必须仍能处理取消。
  for (let index = 0; index < 1024; index++) writeSync(1, buffer);
} else {
  throw new Error("Unknown safe process fixture");
}
