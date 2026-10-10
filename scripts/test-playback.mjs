import { createServer as createHttpServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer as createViteServer } from "vite-plus";
import react from "@vitejs/plugin-react";
import { createLargePlaybackFixture } from "./playback-large-fixture.mjs";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const offlinePackage = process.env.JAVM_OFFLINE_PACKAGE;
const root = await fs.mkdtemp(path.join(project, ".tmp/playback-"));
const media = path.join(root, "media");
await fs.mkdir(media);
// Synthetic test clips need encoders that are intentionally absent from the release tools.
const ffmpeg = process.env.JAVM_FIXTURE_FFMPEG || process.env.JAVM_FFMPEG || "ffmpeg.exe";
const run = (...args) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    windowsHide: true,
    cwd: media,
    timeout: 60000,
  });
run(
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:rate=24",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000",
  "-t",
  "20",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-g",
  "24",
  "-c:a",
  "aac",
  "-movflags",
  "+faststart",
  path.join(media, "fixture.mp4"),
);
await fs.copyFile(path.join(media, "fixture.mp4"), path.join(media, "测试 & 100% #1.mp4"));
await createLargePlaybackFixture(path.join(media, "fixture.mp4"), path.join(media, "large.mp4"));
for (const { name, options } of [
  { name: "playlist", options: [] },
  { name: "fmp4", options: ["-hls_segment_type", "fmp4"] },
  { name: "range", options: ["-hls_flags", "single_file"] },
])
  run(
    "-i",
    path.join(media, "fixture.mp4"),
    "-c",
    "copy",
    "-hls_time",
    "2",
    "-hls_list_size",
    "0",
    ...options,
    "-hls_segment_filename",
    path.join(media, `${name}%02d.${name === "fmp4" ? "m4s" : "ts"}`),
    path.join(media, `${name}.m3u8`),
  );
await fs.writeFile(path.join(media, "key.bin"), Buffer.from("0123456789abcdef"));
await fs.writeFile(path.join(media, "key-info.txt"), `key.bin\n${path.join(media, "key.bin")}\n`);
run(
  "-i",
  path.join(media, "fixture.mp4"),
  "-c",
  "copy",
  "-hls_time",
  "2",
  "-hls_list_size",
  "0",
  "-hls_key_info_file",
  path.join(media, "key-info.txt"),
  "-hls_segment_filename",
  path.join(media, "encrypted%02d.ts"),
  path.join(media, "encrypted.m3u8"),
);

const http = createHttpServer((req, res) => {
  void (async () => {
    const url = new URL(req.url, "http://localhost");
    if (
      url.pathname.startsWith("/referer/") &&
      req.headers.referer !== `http://${req.headers.host}/watch/clip`
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (url.pathname.startsWith("/cors/") || url.pathname === "/redirect.m3u8")
      res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/redirect.m3u8") {
      res.writeHead(302, { Location: "/cors/playlist.m3u8" });
      res.end();
      return;
    }
    if (url.pathname === "/native/slow.m3u8") {
      const timer = setTimeout(() => res.end("#EXTM3U"), 30000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    let name = path.basename(url.pathname);
    if (name === "manifest") name = "playlist.m3u8";
    const bytes = await fs.readFile(path.join(media, name));
    res.setHeader(
      "Content-Type",
      name.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : name.endsWith(".mp4")
          ? "video/mp4"
          : "application/octet-stream",
    );
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    res.writeHead(range ? 206 : 200, {
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
  })().catch(() => {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  });
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${http.address().port}`;
const preferences = process.argv.includes("--preferences");
const fixture = preferences
  ? "playback-preferences"
  : process.argv.includes("--window") || process.env.JAVM_PLAYBACK_WINDOW === "1"
    ? "playback-window"
    : "playback";
let externalPlayer = "";
if (preferences) {
  const probeDirectory = path.join(root, "外部 播放器 & $ test");
  await fs.mkdir(probeDirectory);
  externalPlayer = path.join(probeDirectory, "player's probe.exe");
  const probeSource = path.join(probeDirectory, "probe.cs");
  await fs.writeFile(
    probeSource,
    `using System; using System.IO; using System.Text;
public static class Probe { [STAThread] public static void Main(string[] args) {
File.WriteAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "received.txt"), args, new UTF8Encoding(false));
} }`,
  );
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `Add-Type -Path ${quote(probeSource)} -OutputAssembly ${quote(externalPlayer)} -OutputType WindowsApplication`,
    ],
    { windowsHide: true, timeout: 30000 },
  );
}
let dev;
if (process.env.JAVM_PLAYBACK_DEV === "1") {
  dev = await createViteServer({
    configFile: false,
    root: path.join(project, "tests/fixtures", fixture),
    publicDir: path.join(project, "resources"),
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [project] } },
    logLevel: "error",
  });
  await dev.listen();
}
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures", fixture),
  publicDir: path.join(project, "resources"),
  plugins: [react()],
  build: { outDir: path.join(root, "app"), emptyOutDir: true },
  logLevel: "error",
});
const result = path.join(root, "result.json");
const params = new URLSearchParams({
  source: media,
  endpoint,
  result,
  externalPlayer,
  hold: process.env.JAVM_PLAYBACK_HOLD || "0",
});
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.playbacktest.${crypto.randomUUID()}`,
  enableExtensions: true,
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      // 续播写入隔离测试目录，绝不使用用户的真实片库。
      commandWindows: `"${path.join(offlinePackage || project, "bin/javm_database.exe")}" --database "${path.join(root, "data/downloads-v1.sqlite3")}"`,
    },
  ],
  documentRoot: "/app/",
  url: dev ? `${dev.resolvedUrls.local[0]}?${params}` : `/?${params}`,
  dataLocation: "app",
  storageLocation: "app",
  exportAuthInfo: true,
});
config.nativeAllowList.push(
  "window.snapshot",
  "window.getSize",
  "window.setSize",
  "window.getPosition",
);
config.modes.window = {
  ...config.modes.window,
  title: "JAVM 播放验证",
  width: 1040,
  height: 760,
  useSavedState: false,
  borderless: false,
  exitProcessOnClose: true,
};
await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
if (offlinePackage) {
  await fs.mkdir(path.join(root, "bin/tools"), { recursive: true });
  await fs.copyFile(
    path.join(offlinePackage, "bin/tools/curl.exe"),
    path.join(root, "bin/tools/curl.exe"),
  );
}
const hostEnv = { ...process.env };
if (offlinePackage) delete hostEnv.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
const host = spawn(
  offlinePackage
    ? path.join(offlinePackage, "javm-win_x64.exe")
    : path.join(project, "bin/neutralino-win_x64.exe"),
  ["--res-mode=directory", `--path=${root.replaceAll("\\", "/")}`],
  {
    windowsHide: true,
    stdio: "ignore",
    env: hostEnv,
  },
);
// window.create 的子宿主是后台进程；测试失败或中断也只清理本次隔离目录的窗口。
function stopTestWindows() {
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name = '${offlinePackage ? "javm-win_x64.exe" : "neutralino-win_x64.exe"}'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('\\','/').Contains(${literal(root.replaceAll("\\", "/"))}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true, stdio: "ignore", timeout: 10000 },
  );
}
process.once("SIGINT", () => {
  stopTestWindows();
  void dev?.close();
  http.closeAllConnections();
  http.close();
  process.exit(130);
});
console.log(`Playback test: ${root}`);
try {
  const end = Date.now() + 240000;
  let report;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    report = await fs
      .readFile(result, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (report?.done) break;
    if (host.exitCode !== null) throw new Error(`Test host exited ${host.exitCode}`);
  }
  if (report?.done) {
    report.nativeHost = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `$javmTestProcess = Get-Process -Id ${host.pid}; [pscustomobject]@{peakWorkingSetMiB=[math]::Round($javmTestProcess.PeakWorkingSet64/1MB,1); cpuMs=[math]::Round($javmTestProcess.TotalProcessorTime.TotalMilliseconds)} | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    );
    await fs.writeFile(result, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (
    !report?.done ||
    report.fatal ||
    report.exceptions.length ||
    report.results.some((item) => !item.ok)
  )
    process.exitCode = 1;
  if (process.env.JAVM_PLAYBACK_HOLD === "1") {
    console.log("Hold for UI inspection; Ctrl+C to close fixture.");
    await new Promise(() => {});
  }
} finally {
  stopTestWindows();
  await dev?.close();
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}
