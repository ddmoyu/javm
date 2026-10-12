import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyFfmpegLite } from "./verify-ffmpeg-lite.mjs";
import { verifyMediaInfoLite } from "./verify-mediainfo-lite.mjs";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const bundle = JSON.parse(await readFile(path.join(project, "dist/offline/latest.json"), "utf8"));
const base = path.join(project, ".tmp", `离线 验证-${crypto.randomUUID().slice(0, 8)}`);
console.log(`Offline package validation: ${base}`);
await mkdir(base, { recursive: true });
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-File",
    path.join(project, "scripts/archive-offline.ps1"),
    "-Extract",
    "-Source",
    bundle.archive,
    "-Destination",
    base,
  ],
  { windowsHide: true, timeout: 120000 },
);
const root = path.join(base, (await readdir(base))[0]);
const hostName = bundle.entryPoint ?? "javm-win_x64.exe";
const manifestPath = bundle.manifest ?? path.join(root, "package-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.dependencies.webview2 ||
  manifest.files.some(
    (file) => /^runtime\//i.test(file.path) || /msedgewebview2\.exe$/i.test(file.path),
  ) ||
  (await readdir(root)).some((name) => name.toLowerCase() === "runtime")
)
  throw new Error("Package unexpectedly includes a WebView2 Runtime");
if (manifest.files.some((file) => /(^|\/)ffprobe\.exe$/i.test(file.path)))
  throw new Error("Package unexpectedly includes ffprobe");
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(project, "resources/offline/Verify-Package.ps1"),
    "-PackageDirectory",
    root,
    "-ManifestPath",
    manifestPath,
  ],
  { windowsHide: true, timeout: 120000, stdio: "inherit" },
);
const data = path.join(root, "smoke-data");
await mkdir(data);
const forward = (value) => value.replaceAll("\\", "/");
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const ps = (script) =>
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + script,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  );
const env = {
  ...process.env,
  // Isolate only the test profile; the runtime still comes from Windows.
  WEBVIEW2_USER_DATA_FOLDER: path.join(base, "webview-profile"),
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\Wbem;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`,
};
delete env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
const results = [];
await verifyMediaInfoLite(
  path.join(root, "bin"),
  manifest.dependencies.mediainfo,
  manifest.buildReceipts?.mediainfo,
);
results.push({ name: "Packaged MediaInfo matches the trimmed Release build receipt", ok: true });
const ffmpeg = await verifyFfmpegLite(
  path.join(root, "bin/tools"),
  manifest.dependencies.ffmpeg,
  env,
  manifest.buildReceipts?.ffmpeg,
);
results.push({
  name: "Verified lightweight FFmpeg without ffprobe with system-only PATH",
  ok: true,
  binaries: ffmpeg.binaries,
});
let socket;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(action, timeout = 25000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await action();
    if (result) return result;
    await pause(200);
  } while (Date.now() < deadline);
  throw new Error("Package smoke test timed out");
}
async function auth() {
  return wait(() =>
    readFile(path.join(root, ".tmp/auth_info.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null),
  );
}
async function connect(info) {
  socket = new WebSocket(`ws://127.0.0.1:${info.nlPort}/?connectToken=${info.nlConnectToken}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
}
function call(info, method, data = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`Timeout: ${method}`));
    }, 15000);
    const listener = (message) => {
      const response = JSON.parse(String(message.data));
      if (response.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (response.data?.error) reject(new Error(JSON.stringify(response.data.error)));
      else resolve(response.data?.returnValue ?? response.data);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method, data, accessToken: info.nlToken }));
  });
}
function database(info, method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`Database timeout: ${method}`));
    }, 15000);
    const listener = (message) => {
      const response = JSON.parse(String(message.data));
      if (response.event !== "javm.database.response" || response.data?.requestId !== requestId)
        return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (response.data.ok) resolve(response.data.result);
      else reject(new Error(response.data.error));
    };
    socket.addEventListener("message", listener);
    void call(info, "extensions.dispatch", {
      extensionId: "net.ddmoyu.javm.database",
      event: "javm.database.request",
      data: { requestId, protocol: 1, method, params },
    }).catch((error) => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      reject(error);
    });
  });
}
function cleanup() {
  socket?.close();
  ps(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${literal(root + path.sep)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
}
try {
  // First start the unmodified embedded application, with user databases disabled.
  spawn(
    path.join(root, "JAVM.exe"),
    [
      "--enable-extensions=false",
      "--data-location=app",
      "--storage-location=app",
      "--export-auth-info=true",
      "--window-hidden=true",
      "--window-use-saved-state=false",
    ],
    { env, windowsHide: true, stdio: "ignore" },
  );
  let info = await auth();
  await connect(info);
  await call(info, "app.getConfig");
  const html = await (await fetch(`http://127.0.0.1:${info.nlPort}/`)).text();
  if (!html.includes('id="root"') || !html.includes("/assets/"))
    throw new Error("Embedded frontend missing");
  const systemWebView = await wait(async () => {
    const running = JSON.parse(
      ps(
        `$hosts = @(Get-CimInstance Win32_Process -Filter "Name = '${hostName}'" | Where-Object { $_.ExecutablePath -eq ${literal(path.join(root, hostName))} }).ProcessId; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.ParentProcessId -in $hosts } | Select-Object ExecutablePath,ProcessId,ParentProcessId)`,
      ),
    );
    return running.find(
      (process) =>
        process.ExecutablePath &&
        /\\Microsoft\\EdgeWebView\\Application\\/i.test(process.ExecutablePath) &&
        !process.ExecutablePath.toLowerCase().startsWith(root.toLowerCase() + path.sep),
    );
  }, 60000);
  results.push({
    name: "Embedded application uses system WebView2 with no bundled runtime and system-only PATH",
    ok: true,
    executable: systemWebView.ExecutablePath,
  });
  await call(info, "app.exit").catch(() => {});
  socket.close();
  await pause(1200);
  cleanup();

  // Use the same production assets and binaries with only isolated data paths changed.
  // The embedded production frontend was checked above. Use an inert page for
  // isolated native RPC checks, never frontend files from a newer working tree.
  await mkdir(path.join(root, "smoke-app"));
  await writeFile(
    path.join(root, "smoke-app/index.html"),
    "<!doctype html><title>JAVM native smoke test</title>",
  );
  const config = JSON.parse(await readFile(path.join(project, "neutralino.config.json"), "utf8"));
  Object.assign(config, {
    applicationId: `net.ddmoyu.javm.offlinetest.${crypto.randomUUID()}`,
    documentRoot: "/smoke-app/",
    dataLocation: "app",
    storageLocation: "app",
    exportAuthInfo: true,
  });
  config.extensions[0].commandWindows = `"${forward(path.join(root, "bin/javm_database.exe"))}" --database "${forward(path.join(data, "downloads.sqlite3"))}"`;
  config.modes.window.hidden = true;
  config.modes.window.useSavedState = false;
  await writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
  // The prior auth file is retained but ignored until a new port/token is written.
  const priorToken = info.nlToken;
  spawn(path.join(root, "JAVM.exe"), ["--res-mode=directory"], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  info = await wait(async () => {
    const next = await auth();
    return next.nlToken !== priorToken ? next : null;
  });
  await connect(info);
  const status = await wait(() =>
    database(info, "library.status").catch((error) => {
      if (String(error).includes("NE_EX_EXTNOTC")) return null;
      throw error;
    }),
  );
  if (!status || !Array.isArray(status.directories))
    throw new Error("Library extension unavailable");
  await database(info, "downloads.settings", { directory: data, concurrency: 3 });
  results.push({
    name: "Packaged SQLite extension initializes media library and persists settings",
    ok: true,
  });
  // A self-contained PCM fixture verifies the shipped MediaInfo DLL and official RPC.
  const wav = Buffer.alloc(44 + 16000);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(16000, 40);
  const audioPath = path.join(data, "独立音轨 & 检查.wav");
  await writeFile(audioPath, wav);
  const probe = await database(info, "media.probe", { id: crypto.randomUUID(), path: audioPath });
  if (
    probe.video ||
    !probe.audio ||
    probe.audioTracks !== 1 ||
    Math.abs(probe.durationMs - 1000) > 1
  )
    throw new Error("Packaged MediaInfo probe failed");
  results.push({
    name: "Packaged MediaInfo probes standalone audio through the official Extension without ffprobe",
    ok: true,
  });
  await call(info, "app.exit").catch(() => {});
  socket.close();
  await wait(() =>
    readFile(path.join(data, "downloads.sqlite3.owner.lock"))
      .then(() => false)
      .catch(() => true),
  );
  for (const name of ["downloads.sqlite3", "library.sqlite3"]) {
    const db = new DatabaseSync(path.join(data, name), { readOnly: true });
    try {
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new Error(`${name} integrity check failed`);
    } finally {
      db.close();
    }
  }
  results.push({ name: "Both isolated databases remain valid after host exit", ok: true });
  await writeFile(
    path.join(project, ".tmp/offline-validation.json"),
    JSON.stringify({ root, bundle, results }, null, 2),
  );
  console.log(JSON.stringify({ root, results }, null, 2));
} catch (error) {
  await writeFile(
    path.join(base, "failure-processes.json"),
    ps(
      `Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe' OR Name = '${hostName}'" | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json`,
    ),
  );
  throw error;
} finally {
  cleanup();
}
