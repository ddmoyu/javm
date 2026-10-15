import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "vite-plus";

// 显式执行才访问真实来源。宿主与取流实例全程隐藏，结果仅含主机名、状态码和分辨率。
// 用法：node scripts/test-resource-sources.mjs <番号> [来源ID,...]
const project = path.resolve(import.meta.dirname, "..");
const code = String(process.argv[2] ?? "").toUpperCase();
if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code)) throw new Error("请提供番号。");
const sources = String(process.argv[3] ?? "")
  .split(",")
  .filter(Boolean);
await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
const root = await fs.mkdtemp(path.join(project, ".tmp/resource-sources-"));
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (proxy && !/^(https?|socks5?):\/\/[a-z0-9.:[\]-]+(?::\d+)?\/?$/i.test(proxy))
  throw new Error("验证只接受无凭据的代理地址。");
await fs.writeFile(path.join(root, "sweep.json"), JSON.stringify({ code, sources, proxy }));
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/resource-source-sweep"),
  build: { outDir: path.join(root, "app"), emptyOutDir: true, target: "esnext" },
  logLevel: "error",
});
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.sourcetest.${crypto.randomUUID()}`,
  documentRoot: "/app/",
  url: `/?${new URLSearchParams({ root }).toString()}`,
  dataLocation: "app",
  storageLocation: "app",
  logging: { enabled: false },
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      commandWindows: `"${path.join(project, "bin/javm_database.exe")}" --database "${path.join(root, "sweep.sqlite3")}"`,
    },
  ],
});
Object.assign(config.modes.window, {
  hidden: true,
  skipTaskbar: true,
  useSavedState: false,
  // hiddenProcess 要求端口模板；宿主本身只加载本地验证页。
  webviewArgs:
    "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --mute-audio --blink-settings=imagesEnabled=false",
});
await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
await fs.writeFile(
  path.join(root, "launch.json"),
  JSON.stringify({
    file: path.join(project, "bin/neutralino-win_x64.exe"),
    arguments: `--res-mode=directory --path="${root}"`,
    profile: path.join(root, "profile"),
    ownerPid: process.pid,
    timeoutMs: 30 * 60 * 1000,
  }),
);
console.log(JSON.stringify({ root, code, sources, proxyConfigured: !!proxy }));
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
let reported = 0;
const monitor = setInterval(() => {
  void fs
    .readFile(path.join(root, "progress.json"), "utf8")
    .then((text) => {
      const rows = JSON.parse(text);
      for (const row of rows.slice(reported))
        console.log(`${row.source}: ${row.ok ? "ok" : row.code} ${row.finishedMs}ms`);
      reported = rows.length;
    })
    .catch(() => {});
}, 5000);
try {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const result = JSON.parse(
    await fs.readFile(path.join(root, "result.json"), "utf8").catch(() => {
      throw new Error(`验证宿主没有输出结果：${diagnostic}`);
    }),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearInterval(monitor);
  if (child.exitCode === null) child.kill();
}
