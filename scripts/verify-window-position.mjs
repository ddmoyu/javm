import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { build } from "vite-plus";

if (process.platform !== "win32") throw new Error("窗口位置验证需要 Windows");
const project = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(project, ".tmp/window-position-safe-"));
const output = path.join(root, "app");
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/window-position"),
  publicDir: false,
  build: { outDir: output, emptyOutDir: true },
  logLevel: "error",
});
const baseConfig = JSON.parse(await readFile(path.join(project, "neutralino.config.json"), "utf8"));
const readResult = (file) =>
  readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);
const reports = [];
async function verify(name, position, size, recover, options = {}) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, ".tmp"), { recursive: true });
  await mkdir(path.join(directory, ".storage"));
  await cp(output, path.join(directory, "app"), { recursive: true });
  const saved = {
    ...position,
    ...size,
    minWidth: 760,
    minHeight: 540,
    maxWidth: -1,
    maxHeight: -1,
    maximize: false,
    resizable: true,
  };
  await writeFile(path.join(directory, ".tmp/window_state.config.json"), JSON.stringify(saved));
  await writeFile(path.join(directory, ".storage/main-window-size-1440x900-v1.neustorage"), "true");
  const config = structuredClone(baseConfig);
  Object.assign(config, {
    applicationId: `net.ddmoyu.javm.safewindow.${crypto.randomUUID()}`,
    dataLocation: "app",
    storageLocation: "app",
    documentRoot: "/app/",
    url: options.simulateMinimum ? "/?simulateMinimum=true" : "/",
    extensions: [
      {
        id: "net.ddmoyu.javm.database",
        commandWindows: `"${path.join(project, "bin/javm_database.exe")}" --database "${path.join(directory, "unused.sqlite3")}"`,
      },
    ],
  });
  // 仅加载安全文字页面，独立存储、无媒体和真实来源请求。
  // 走正常启动定位后由页面立即隐藏；hidden:true 会让宿主跳过还原位置。
  Object.assign(config.modes.window, {
    title: "安全窗口位置验证",
    hidden: false,
    skipTaskbar: true,
    useSavedState: true,
    enableInspector: false,
    webviewArgs:
      "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-background-networking --no-proxy-server",
  });
  await writeFile(path.join(directory, "neutralino.config.json"), JSON.stringify(config));
  const child = spawn(
    path.join(project, "bin/neutralino-win_x64.exe"),
    ["--res-mode=directory", `--path=${directory.replaceAll("\\", "/")}`],
    {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "profile") },
    },
  );
  let failure;
  child.once("error", (error) => {
    failure = error;
  });
  try {
    const deadline = Date.now() + 20000;
    while (child.exitCode === null && !failure && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (failure) throw failure;
    const report = await readResult(path.join(directory, "result.json"));
    assert.equal(child.exitCode, 0, `${name} (${directory}): ${JSON.stringify(report)}`);
    assert.ok(report && !report.error, `${name}: ${JSON.stringify(report)}`);
    if (options.expectedSize)
      assert.deepEqual(
        { width: report.after.size.width, height: report.after.size.height },
        options.expectedSize,
        `${name}: 恢复尺寸`,
      );
    if (options.simulateMinimum)
      assert.deepEqual(
        { width: report.before.size.width, height: report.before.size.height },
        { width: 760, height: 540 },
        `${name}: 应复现实际窗口缩至最小尺寸`,
      );
    if (recover) {
      const primary = report.displays.find((display) => display.primary).workArea;
      const expected = {
        x: Math.round(primary.x + (primary.width - report.after.size.width) / 2),
        y: Math.round(primary.y + (primary.height - report.after.size.height) / 2),
      };
      assert.deepEqual(report.after.position, expected, name);
    } else {
      assert.deepEqual(report.before.position, position, `${name}: 宿主应先还原已保存的位置`);
      assert.deepEqual(report.after.position, position, name);
    }
    const persisted = await readResult(path.join(directory, ".tmp/window_state.config.json"));
    assert.deepEqual(
      { x: persisted?.x, y: persisted?.y, width: persisted?.width, height: persisted?.height },
      {
        ...report.after.position,
        width: report.after.size.width,
        height: report.after.size.height,
      },
      `${name}: 退出后应由宿主保存最终位置和尺寸`,
    );
    assert.ok(
      !(await readdir(directory)).some((file) => /\.sqlite3/.test(file)),
      "只读显示查询不应打开数据库",
    );
    reports.push({ name, ...report });
    return report;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
if (process.argv.includes("--sizes")) {
  const primary = { x: 100, y: 50 };
  const offscreen = { x: 32767, y: -32768 };
  const minimum = { width: 760, height: 540 };
  const saved = { width: 1640, height: 950 };
  await verify("restore-saved-size", primary, saved, false, {
    simulateMinimum: true,
    expectedSize: saved,
  });
  await verify("restore-offscreen-size", offscreen, saved, true, {
    simulateMinimum: true,
    expectedSize: saved,
  });
  await verify("recover-default-size", offscreen, minimum, true, {
    expectedSize: { width: 1440, height: 900 },
  });
  await verify("preserve-saved-minimum", primary, minimum, false, { expectedSize: minimum });
  const custom = { width: 1000, height: 800 };
  await verify("preserve-custom-size", primary, custom, false, { expectedSize: custom });
} else {
  const initial = await verify(
    "offscreen",
    { x: 32767, y: -32768 },
    { width: 760, height: 540 },
    true,
  );
  await verify("primary", { x: 100, y: 100 }, { width: 960, height: 700 }, false);
  await verify("oversized-primary", { x: 100, y: 100 }, { width: 2400, height: 1400 }, false);
  await verify("oversized-offscreen", { x: 32767, y: -32768 }, { width: 2400, height: 1400 }, true);
  const secondary = initial.displays.find((display) => !display.primary);
  if (secondary)
    await verify(
      "secondary",
      { x: secondary.workArea.x + 32, y: secondary.workArea.y + 32 },
      { width: 960, height: 700 },
      false,
    );
}
await writeFile(path.join(root, "verification.json"), JSON.stringify({ reports }, null, 2));
console.log(JSON.stringify({ root, passed: reports.map((report) => report.name) }, null, 2));
