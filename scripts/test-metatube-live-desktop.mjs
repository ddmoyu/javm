// Manual end-to-end validation: the unmodified production UI, real native services,
// real MetaTube sources, and a synthetic video served by an isolated local HTTP server.
import { promises as fs, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
const root = await fs.mkdtemp(path.join(project, ".tmp/metatube-live-desktop-"));
await fs.mkdir(path.join(root, "media"));
await fs.mkdir(path.join(root, "downloads"));
await fs.mkdir(path.join(root, "data/JAVM"), { recursive: true });
await fs.mkdir(path.join(root, "bin"));
await fs.cp(path.join(project, "dist/frontend"), path.join(root, "app"), { recursive: true });
await fs.cp(path.join(project, "resources"), path.join(root, "resources"), { recursive: true });
await fs.cp(path.join(project, "bin/tools"), path.join(root, "bin/tools"), { recursive: true });
for (const file of ["javm_database.exe", "MediaInfo.dll"])
  await fs.copyFile(path.join(project, "bin", file), path.join(root, "bin", file));
const clip = path.join(root, "media/fixture.mp4");
execFileSync(
  process.env.JAVM_FIXTURE_FFMPEG || "ffmpeg.exe",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    clip,
  ],
  { windowsHide: true, timeout: 30000 },
);
const size = (await fs.stat(clip)).size;
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (!/^\/[^/]+\.mp4$/.test(url.pathname)) {
    response.writeHead(404).end();
    return;
  }
  let start = 0,
    end = size - 1;
  if (request.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    if (!match || +match[1] >= size) {
      response.writeHead(416).end();
      return;
    }
    start = +match[1];
    if (match[2]) end = Math.min(+match[2], end);
  }
  requests.push({ method: request.method, path: url.pathname, start, end });
  response.writeHead(start || request.headers.range ? 206 : 200, {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(request.headers.range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(clip, { start, end }).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.live.${crypto.randomUUID()}`,
  documentRoot: "/app/",
  url: "/",
  dataLocation: "app",
  storageLocation: "app",
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      commandWindows: `"${path.join(root, "bin/javm_database.exe")}" --database "${path.join(root, "data/JAVM/downloads-v1.sqlite3")}"`,
    },
  ],
});
Object.assign(config.modes.window, {
  title: "JAVM 隔离联调",
  useSavedState: false,
  width: 1180,
  height: 840,
});
await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config, null, 2));
const host = spawn(
  path.join(project, "bin/neutralino-win_x64.exe"),
  ["--res-mode=directory", `--path=${root.replaceAll("\\", "/")}`],
  {
    // This is the interactive GUI under test; hiding it also hides its WebView child.
    windowsHide: false,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview-profile") },
  },
);
const context = {
  root,
  pid: host.pid,
  base: `http://127.0.0.1:${server.address().port}`,
  clip,
  size,
};
await fs.writeFile(path.join(root, "context.json"), JSON.stringify(context, null, 2));
console.log(JSON.stringify(context));
await new Promise((resolve, reject) => {
  host.once("exit", resolve);
  host.once("error", reject);
});
await fs.writeFile(path.join(root, "download-requests.json"), JSON.stringify(requests, null, 2));
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(
  JSON.stringify({ hostExitCode: host.exitCode, downloadRequests: requests.length, root }),
);
