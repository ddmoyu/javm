import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";

if (process.platform !== "win32") throw new Error("此隐藏桌面验证使用 Windows Job 隔离宿主");
const project = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(project, ".tmp/feedback-native-run-"));
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/feedback-native"),
  plugins: [react()],
  build: { outDir: path.join(root, "app"), target: "esnext", emptyOutDir: true },
  logLevel: "error",
});
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.feedbacktest.${crypto.randomUUID()}`,
  documentRoot: "/app/",
  dataLocation: "app",
  storageLocation: "app",
  logging: { enabled: false },
  enableExtensions: false,
  extensions: [],
  nativeAllowList: [...config.nativeAllowList, "clipboard.readText", "clipboard.getFormat"],
});
Object.assign(config.modes.window, {
  title: "JAVM 安全反馈验证",
  hidden: true,
  skipTaskbar: true,
  useSavedState: false,
  webviewArgs: "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --mute-audio",
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const results = [];
console.log(JSON.stringify({ root }));
for (const phase of ["crash", "recover", "normal"]) {
  config.url = `/?${new URLSearchParams({ root, phase })}`;
  await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
  const launchPath = path.join(root, "launch.json");
  await fs.writeFile(
    launchPath,
    JSON.stringify({
      file: path.join(project, "bin/neutralino-win_x64.exe"),
      arguments: `--res-mode=directory --path="${root.replaceAll("\\", "/")}"`,
      profile: path.join(root, `profile-${phase}`),
      ownerPid: process.pid,
      timeoutMs: 45000,
    }),
  );
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
      launchPath,
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + String(chunk)).slice(-2000);
  });
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    const limit = Date.now() + 40000;
    let result;
    while (!result && Date.now() < limit && child.exitCode === null) {
      try {
        result = JSON.parse(await fs.readFile(path.join(root, `${phase}.json`), "utf8"));
      } catch {
        await pause();
      }
    }
    if (!result) throw new Error(`桌面验证未输出 ${phase} 结果：${diagnostic}`);
    console.log(JSON.stringify(result));
    results.push(result);
    if (!result.ok) throw new Error(`桌面反馈验证失败：${result.error}`);
    if (phase === "crash") {
      // 只结束本次启动的 PowerShell Job；其中仅有隔离的 Neutralino 与 WebView。
      child.kill();
      await ended;
      const folder = path.join(root, "diagnostics");
      const snapshots = (await fs.readdir(folder))
        .filter((name) => name.startsWith("report-"))
        .sort();
      if (!snapshots.length) throw new Error("终止前没有持久化快照");
      const generation = Number(snapshots.at(-1).split("-")[1]) + 1;
      await fs.writeFile(
        path.join(
          folder,
          `report-${String(generation).padStart(16, "0")}-${crypto.randomUUID()}.json`,
        ),
        '{"payload":"interrupted',
      );
    } else await ended;
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await ended;
    }
  }
}
await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ ok: true, results }, null, 2));
console.log(JSON.stringify({ ok: true, result: path.join(root, "result.json") }));
