import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "vite-plus";
import { verifyPublicResourceFile } from "./verify-public-resource-file.mjs";

// 显式执行才访问网络；固定官方播放器和公开非露骨视频，不接受其他来源或媒体参数。
const project = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(project, ".tmp/public-resource-download-"));
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (proxy && !/^(https?|socks5?):\/\/[a-z0-9.:[\]-]+(?::\d+)?\/?$/i.test(proxy))
  throw new Error("公开验证只接受无凭据的代理地址。");
await fs.writeFile(
  path.join(root, "verification.json"),
  JSON.stringify({ tools: path.join(project, "bin/tools"), proxy }),
);
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/public-resource-download"),
  build: { outDir: path.join(root, "app"), emptyOutDir: true, target: "esnext" },
  logLevel: "error",
});
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.publictest.${crypto.randomUUID()}`,
  documentRoot: "/app/",
  url: `/?${new URLSearchParams({ root }).toString()}`,
  dataLocation: "app",
  storageLocation: "app",
  logging: { enabled: false },
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      commandWindows: `"${path.join(project, "bin/javm_database.exe")}" --database "${path.join(root, "verification.sqlite3")}"`,
    },
  ],
});
Object.assign(config.modes.window, {
  hidden: true,
  skipTaskbar: true,
  useSavedState: false,
  webviewArgs: "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --mute-audio",
});
await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
await fs.writeFile(
  path.join(root, "launch.json"),
  JSON.stringify({
    file: path.join(project, "bin/neutralino-win_x64.exe"),
    arguments: `--res-mode=directory --path="${root}"`,
    profile: path.join(root, "profile"),
    ownerPid: process.pid,
    timeoutMs: 12 * 60 * 1000,
  }),
);
console.log(JSON.stringify({ root, proxyConfigured: !!proxy }));
const child = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(project, "frontend/src/platform/neutralino/hiddenProcess.ps1"),
    "-Config",
    path.join(root, "launch.json"),
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
let diagnostic = "";
child.stderr.on("data", (chunk) => {
  diagnostic = (diagnostic + String(chunk)).slice(-4000);
});
const monitor = setInterval(() => {
  void fs
    .readFile(path.join(root, "progress.json"), "utf8")
    .then(console.log)
    .catch(() => {});
}, 15000);
try {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let result = JSON.parse(
    await fs.readFile(path.join(root, "result.json"), "utf8").catch(() => {
      throw new Error(`验证宿主没有输出结果：${diagnostic}`);
    }),
  );
  if (result.ok) result = await verifyPublicResourceFile(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  clearInterval(monitor);
  if (child.exitCode === null) child.kill();
}
