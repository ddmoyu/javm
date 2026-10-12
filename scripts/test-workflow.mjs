import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";

// Only generated color frames, fictional metadata and loopback requests are accepted.
const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
const root = await fs.mkdtemp(path.join(project, ".tmp/workflow-"));
for (const dir of ["media", "output", "backups", "temp", "data", "bin/tools"])
  await fs.mkdir(path.join(root, dir), { recursive: true });
for (const file of ["curl.exe", "ffmpeg.exe"])
  await fs.copyFile(path.join(project, "bin/tools", file), path.join(root, "bin/tools", file));
const ffmpeg = process.env.JAVM_FIXTURE_FFMPEG || "ffmpeg.exe";
const run = (...args) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    windowsHide: true,
    cwd: path.join(root, "media"),
    timeout: 60000,
  });
run(
  "-f",
  "lavfi",
  "-i",
  "color=c=navy:s=320x180:r=24",
  "-f",
  "lavfi",
  "-i",
  "anullsrc=r=48000:cl=stereo",
  "-t",
  "8",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-g",
  "24",
  "-c:a",
  "aac",
  "safe.mp4",
);
run(
  "-i",
  "safe.mp4",
  "-c",
  "copy",
  "-hls_time",
  "2",
  "-hls_list_size",
  "0",
  "-hls_segment_filename",
  "segment%02d.ts",
  "variant.m3u8",
);
run("-f", "lavfi", "-i", "color=c=navy:s=200x300", "-frames:v", "1", "poster.jpg");
const requests = [];
let base;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push(url.pathname);
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname.startsWith("/page/")) {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<p>Safe fictional documentary</p><video src="${base}/media/master.m3u8"></video>`,
      );
    } else if (url.pathname === "/metadata/search") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify([
          { provider: "safe", id: "demo-001", code: "DEMO-001", title: "安全合成纪录片" },
        ]),
      );
    } else if (url.pathname === "/metadata/demo-001") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          provider: "safe",
          id: "demo-001",
          number: "DEMO-001",
          title: "安全合成纪录片",
          summary: "纯色画面的虚构测试资料",
          cover_url: `${base}/media/poster.jpg`,
          homepage: `${base}/page/demo-001`,
          genres: ["安全样例"],
        }),
      );
    } else if (url.pathname === "/media/master.m3u8") {
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      response.end(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=160000,RESOLUTION=320x180\nvariant.m3u8\n",
      );
    } else if (/^\/media\/(?:variant\.m3u8|segment\d+\.ts|poster\.jpg)$/.test(url.pathname)) {
      response.setHeader(
        "Content-Type",
        url.pathname.endsWith("m3u8")
          ? "application/vnd.apple.mpegurl"
          : url.pathname.endsWith("jpg")
            ? "image/jpeg"
            : "video/mp2t",
      );
      response.end(await fs.readFile(path.join(root, "media", path.basename(url.pathname))));
    } else {
      response.writeHead(404);
      response.end("Safe fixture only");
    }
  } catch {
    response.writeHead(500);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
let child;
try {
  await build({
    configFile: false,
    root: path.join(project, "tests/fixtures/workflow"),
    plugins: [react()],
    build: { outDir: path.join(root, "app"), emptyOutDir: true },
    logLevel: "error",
  });
  await fs.copyFile(
    path.join(project, "resources/playback-worker.js"),
    path.join(root, "app/playback-worker.js"),
  );
  const config = JSON.parse(
    await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"),
  );
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  config.port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  Object.assign(config, {
    applicationId: `net.ddmoyu.javm.workflow.${crypto.randomUUID()}`,
    documentRoot: "/app/",
    url: `/?${new URLSearchParams({ base, root })}`,
    enableExtensions: true,
    extensions: [
      {
        id: "net.ddmoyu.javm.database",
        commandWindows: `"${project}/bin/javm_database.exe" --database "${root}/data/downloads.sqlite3"`,
      },
    ],
    dataLocation: "app",
    storageLocation: "app",
    logging: { enabled: false },
  });
  Object.assign(config.modes.window, {
    title: "JAVM safe workflow",
    hidden: true,
    skipTaskbar: true,
    useSavedState: false,
    webviewArgs: `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --remote-allow-origins=http://127.0.0.1:${config.port} --mute-audio --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=localhost;127.0.0.1`,
  });
  await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
  await fs.writeFile(
    path.join(root, "launch.json"),
    JSON.stringify({
      file: path.join(project, "bin/neutralino-win_x64.exe"),
      arguments: `--res-mode=directory --path="${root}"`,
      profile: path.join(root, "profile"),
      ownerPid: process.pid,
      timeoutMs: 170000,
    }),
  );
  child = spawn(
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
    {
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, TEMP: path.join(root, "temp"), TMP: path.join(root, "temp") },
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-3000);
  });
  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const report = JSON.parse(
    await fs
      .readFile(path.join(root, "result.json"), "utf8")
      .catch(() => JSON.stringify({ ok: false, exit, diagnostics })),
  );
  await fs.writeFile(
    path.join(root, "report.json"),
    JSON.stringify({ ...report, requests }, null, 2),
  );
  console.log(JSON.stringify({ root, ...report, requests }, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
