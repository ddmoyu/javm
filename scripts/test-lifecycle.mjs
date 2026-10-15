import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const root = await fs.mkdtemp(path.join(project, ".tmp/lifecycle-"));
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/lifecycle"),
  publicDir: path.join(project, "resources"),
  plugins: [react()],
  build: { outDir: path.join(root, "app"), emptyOutDir: true },
  logLevel: "error",
});
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.lifecycletest.${crypto.randomUUID()}`,
  documentRoot: "/app/",
  dataLocation: "app",
  storageLocation: "app",
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      commandWindows: `"${path.join(project, "bin/javm_database.exe")}" --database "${path.join(root, "data/downloads-v1.sqlite3")}"`,
    },
  ],
});
config.nativeAllowList.push("window.isVisible");
Object.assign(config.modes.window, {
  title: "JAVM 后台运行验证",
  useSavedState: false,
  exitProcessOnClose: false,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) =>
  fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);
const reports = [];
console.log(`Lifecycle test: ${root}`);
for (const phase of ["first", "restart", "tray-exit"]) {
  const result = path.join(root, `${phase}.json`);
  config.url = `/?${new URLSearchParams({ phase, result })}`;
  await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
  const host = spawn(
    path.join(project, "bin/neutralino-win_x64.exe"),
    ["--res-mode=directory", `--path=${root.replaceAll("\\", "/")}`],
    { windowsHide: true, stdio: "ignore" },
  );
  let spawnError;
  host.on("error", (error) => {
    spawnError = error;
  });
  try {
    const deadline = Date.now() + 60000;
    while (host.exitCode === null && !spawnError && Date.now() < deadline) {
      const report = await readJson(result);
      if (report?.fatal || report?.exceptions.length) throw new Error(JSON.stringify(report));
      await sleep(200);
    }
    if (spawnError) throw spawnError;
    if (host.exitCode === null) throw new Error(`${phase}: 主窗口关闭后宿主未退出`);
    const report = await readJson(result);
    if (host.exitCode !== 0 || !report?.done || report.fatal || report.exceptions.length)
      throw new Error(`${phase}: 宿主提前退出或验证失败 ${JSON.stringify(report)}`);
    report.results.push("统一退出流程完成，宿主正常退出");
    reports.push(report);
  } finally {
    if (host.exitCode === null) host.kill();
  }
}
// 只查询本次隔离测试目录所属的扩展，避免触碰用户正在使用的应用。
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const remaining = () =>
  JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name = 'javm_database.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${literal(root)}) }).Count | ConvertTo-Json`,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 10000 },
    ),
  );
await sleep(500);
if (remaining()) throw new Error("宿主退出后仍有测试数据库扩展残留");
const report = { done: true, reports, databaseProcessCleanup: true };
await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
