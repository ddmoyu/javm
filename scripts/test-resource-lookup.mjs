import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";

// Safe, synthetic text and bytes only. Never accepts a public site or movie input.
const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
const root = await fs.mkdtemp(path.join(project, ".tmp/resource-lookup-"));
const resultPath = path.join(root, "result.json");
const requests = [];
let base = "",
  frameBase = "";
const frameServer = createServer((request, response) => {
  const code = new URL(request.url, "http://127.0.0.1").pathname.split("/").at(-1);
  requests.push(`/frame/${code}`);
  response.setHeader("Content-Type", "text/html");
  response.setHeader("Referrer-Policy", "unsafe-url");
  response.end(
    `<p>Safe cross-origin mock player</p><script>setTimeout(()=>fetch('${base}/hls/${code}/${code === "demo-004" ? "manifest" : "master.m3u8"}?token=safe'),300)</script>`,
  );
});
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  requests.push(url.pathname);
  if (url.pathname.startsWith("/page/")) {
    const code = url.pathname.split("/").at(-1);
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<p>Safe fictional ${code}</p><iframe src="${frameBase}/frame/${code}"></iframe><img src="/blocked.png"><script>window.open('/popup');</script>`,
    );
  } else if (url.pathname.endsWith("/master.m3u8") || url.pathname.endsWith("/manifest")) {
    if (!/\/frame\/demo-00[14]$/.test(String(request.headers.referer))) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nvariant.m3u8\n");
  } else if (url.pathname.endsWith("/variant.m3u8")) {
    response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    response.end("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.bin\n#EXT-X-ENDLIST\n");
  } else if (url.pathname.endsWith("/segment.bin")) {
    response.setHeader("Content-Type", "application/octet-stream");
    response.end(Buffer.from([0x47, 0x40, 0, 0x10, 0, 0, 0, 0]));
  } else if (url.pathname.startsWith("/empty/") || url.pathname.startsWith("/slow/")) {
    response.setHeader("Content-Type", "text/html");
    response.end("<p>Safe mock without a stream</p>");
  } else {
    response.writeHead(404);
    response.end("Safe mock not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => frameServer.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;
frameBase = `http://127.0.0.1:${frameServer.address().port}`;
let child;
try {
  await build({
    configFile: false,
    root: path.join(project, "tests/fixtures/resource-lookup"),
    plugins: [react()],
    build: { outDir: path.join(root, "app"), emptyOutDir: true },
    logLevel: "error",
  });
  const config = JSON.parse(
    await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"),
  );
  Object.assign(config, {
    applicationId: `net.ddmoyu.javm.lookuptest.${crypto.randomUUID()}`,
    documentRoot: "/app/",
    url: `/?${new URLSearchParams({ base, frameBase, result: resultPath })}`,
    enableExtensions: false,
    extensions: [],
    dataLocation: "app",
    storageLocation: "app",
    logging: { enabled: false },
  });
  Object.assign(config.modes.window, {
    title: "Safe resource lookup mock",
    hidden: true,
    skipTaskbar: true,
    useSavedState: false,
    webviewArgs:
      "--mute-audio --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=localhost;127.0.0.1",
  });
  await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
  await fs.writeFile(
    path.join(root, "launch.json"),
    JSON.stringify({
      file: path.join(project, "bin/neutralino-win_x64.exe"),
      arguments: `--res-mode=directory --path="${root}"`,
      profile: path.join(root, "profile"),
      ownerPid: process.pid,
      timeoutMs: 110000,
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
    { windowsHide: true, stdio: "pipe" },
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
      .readFile(resultPath, "utf8")
      .catch(() => JSON.stringify({ ok: false, error: `controller exit ${exit}`, diagnostics })),
  );
  report.noImagesOrPopups = !requests.some((url) => ["/blocked.png", "/popup"].includes(url));
  report.requests = requests;
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
  if (!report.ok || !report.noImagesOrPopups) process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  server.closeAllConnections();
  frameServer.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => frameServer.close(resolve));
}
