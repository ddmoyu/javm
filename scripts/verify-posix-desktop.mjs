import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";
import { desktopHostFile } from "./desktop-host.mjs";
import { root, target, run } from "./third-party/posix/common.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "桌面验证仅在隔离的 CI 桌面运行");
assert.ok(["linux", "darwin"].includes(process.platform));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".tmp/safe-desktop-"));
const bundle = path.join(directory, "安全 ' 空格", "JAVM.app");
const application =
  process.platform === "darwin"
    ? path.join(bundle, "Contents/MacOS")
    : path.join(directory, "安全 ' 空格");
await mkdir(path.join(application, "bin/tools"), { recursive: true });
await mkdir(path.join(application, "resources"));
await cp(path.join(root, "tests/fixtures/posix-desktop/media"), path.join(application, "media"), {
  recursive: true,
});
await copyFile(path.join(root, "resources/icon.png"), path.join(application, "resources/icon.png"));
for (const file of [
  "javm_database",
  "javm_process",
  process.platform === "darwin" ? "libmediainfo.0.dylib" : "libmediainfo.so.0",
  "tools/ffmpeg",
  "tools/curl",
])
  await copyFile(path.join(root, "bin", file), path.join(application, "bin", file));
await copyFile(path.join(root, "bin", desktopHostFile()), path.join(application, "JAVM-host"));
if (process.platform === "darwin") {
  await copyFile(path.join(root, "bin/javm_launcher"), path.join(application, "JAVM"));
  await writeFile(
    path.join(bundle, "Contents/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>net.ddmoyu.javm.desktopfixture</string><key>CFBundleName</key><string>JAVM Safe Fixture</string><key>CFBundleExecutable</key><string>JAVM</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>',
  );
}
const directProbe = JSON.parse(
  await run(
    path.join(application, "bin/javm_database"),
    ["--media-probe", path.join(application, "media/pattern.mp4")],
    application,
    true,
    { ...process.env, LC_ALL: "C", LANG: "C" },
  ),
);
assert.ok(directProbe.video && directProbe.durationMs >= 2000, "C locale 下必须能探测中文路径");
await build({
  configFile: false,
  root: path.join(root, "tests/fixtures/posix-desktop"),
  publicDir: false,
  plugins: [react()],
  build: {
    target: ["safari16", "chrome105"],
    cssTarget: ["safari16", "chrome105"],
    outDir: path.join(application, "app"),
    emptyOutDir: true,
  },
  logLevel: "error",
});
const media = new Map(
  await Promise.all(
    ["pattern.mp4", "playlist.m3u8", "segment-0.ts", "segment-1.ts", "segment-2.ts"].map(
      async (name) => [name, await readFile(path.join(application, "media", name))],
    ),
  ),
);
let cookieReused = false,
  captures = 0,
  ranges = 0;
const http = createServer((request, response) => {
  const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  if (name === "capture") {
    captures++;
    cookieReused ||= (request.headers.cookie ?? "").includes("SAFE_SESSION");
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'");
    response.setHeader("Set-Cookie", "SAFE_SESSION=fixture; Path=/; SameSite=Lax");
    response.end('<!doctype html><title>Safe forest page</title><iframe src="/frame"></iframe>');
    return;
  }
  if (name === "frame") {
    response.setHeader("Content-Type", "text/html");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    response.end(
      '<!doctype html><title>Safe frame</title><script>void fetch(["/play","list.m3u8"].join(""))</script>',
    );
    return;
  }
  if (name === "empty") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Safe empty page</title>");
    return;
  }
  if (name === "stall.mp4") {
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Length", 100_000_000);
    const timer = setInterval(() => response.write(Buffer.alloc(1024)), 100);
    response.on("close", () => clearInterval(timer));
    return;
  }
  const data = media.get(name);
  if (!data) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader(
    "Content-Type",
    name.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : name.endsWith(".ts")
        ? "video/mp2t"
        : "video/mp4",
  );
  response.setHeader("Accept-Ranges", "bytes");
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (match) {
    const start = Number(match[1]),
      end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
    if (start > end || start >= data.length) {
      response.writeHead(416).end();
      return;
    }
    ranges++;
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${data.length}`,
      "Content-Length": end - start + 1,
    });
    response.end(data.subarray(start, end + 1));
  } else {
    response.setHeader("Content-Length", data.length);
    response.end(data);
  }
});
http.listen(0, "127.0.0.1");
await once(http, "listening");
const origin = `http://127.0.0.1:${http.address().port}`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const config = {
  applicationId: "net.ddmoyu.javm.desktopfixture",
  defaultMode: "window",
  documentRoot: "/app/",
  port: 0,
  enableServer: true,
  enableNativeAPI: true,
  enableExtensions: true,
  tokenSecurity: "one-time",
  dataLocation: "app",
  storageLocation: "app",
  logging: { enabled: false },
  nativeAllowList: [
    "app.*",
    "events.*",
    "filesystem.*",
    "os.*",
    "extensions.*",
    "server.*",
    "window.*",
    "storage.*",
  ],
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      commandLinux: `exec ./bin/javm_database --database ${quote(path.join(application, "safe.sqlite3"))}`,
      commandDarwin: `exec ./bin/javm_database --database ${quote(path.join(application, "safe.sqlite3"))}`,
    },
  ],
  modes: {
    window: {
      title: "JAVM Safe Platform Fixture",
      width: 800,
      height: 600,
      useSavedState: false,
      exitProcessOnClose: false,
      enableInspector: false,
      injectGlobals: true,
      webviewArgs: "--javm-managed",
      newWindowPolicy: "custom",
    },
  },
};
const reports = [];
async function stopOwnedGroup(pid) {
  if (!pid) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (signal === "SIGTERM") await delay(1200);
  }
}
try {
  for (const phase of ["desktop", "tray-fallback"]) {
    config.url = `/?${new URLSearchParams({ root: application, origin, phase })}`;
    config.nativeBlockList = phase === "tray-fallback" ? ["os.setTray"] : [];
    await writeFile(path.join(application, "neutralino.config.json"), JSON.stringify(config));
    const home = path.join(directory, "home");
    await mkdir(home, { recursive: true });
    const child = spawn(
      path.join(application, process.platform === "darwin" ? "JAVM" : "JAVM-host"),
      ["--res-mode=directory", `--path=${application}`],
      {
        cwd: application,
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          XDG_CONFIG_HOME: path.join(home, "config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let diagnostics = "",
      spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    const consume = (data) => {
      diagnostics = (diagnostics + data).slice(-4000);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    try {
      const deadline = Date.now() + 160000;
      let requestedQuit = false;
      while (
        child.exitCode === null &&
        child.signalCode === null &&
        !spawnError &&
        Date.now() < deadline
      ) {
        if (process.platform === "darwin" && phase === "desktop" && !requestedQuit) {
          try {
            const progress = JSON.parse(
              await readFile(path.join(application, "desktop.json"), "utf8"),
            );
            if (progress.readyToQuit) {
              requestedQuit = true;
              const accepted = await run(
                "osascript",
                [
                  "-l",
                  "JavaScript",
                  "-e",
                  `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).terminate;`,
                ],
                root,
                true,
              );
              assert.equal(accepted, "true", "系统未接收 APP 退出请求");
            }
          } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          }
        }
        await delay(100);
      }
      if (spawnError) throw spawnError;
      let report;
      try {
        report = JSON.parse(await readFile(path.join(application, `${phase}.json`), "utf8"));
      } catch {
        /* A bootstrap failure cannot write through the API. */
      }
      assert.ok(
        child.exitCode === 0 && report?.done && !report.fatal && !report.errors.length,
        `${phase}: ${JSON.stringify(report)} ${diagnostics}`,
      );
      reports.push(report);
    } finally {
      // This entire process group was created for the safe fixture.
      await stopOwnedGroup(child.pid);
    }
  }
  assert.ok(captures >= 2);
  assert.equal(cookieReused, false, "Hidden views reused cookies");
  assert.ok(ranges > 0);
  const output = path.join(root, `build/desktop-verification-${target}.json`);
  await writeFile(
    output,
    JSON.stringify(
      {
        platform: target,
        sourceCommit: await run("git", ["rev-parse", "HEAD"], root, true),
        gui: true,
        cookieIsolation: true,
        reports,
      },
      null,
      2,
    ),
  );
  console.log(
    `${target}: safe GUI, downloads, HLS/MP4 playback, hidden WebKit and lifecycle verified`,
  );
} finally {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  // Retain only safe diagnostics on failure; successful runs have a compact report.
  if (reports.length === 2) await rm(directory, { recursive: true, force: true });
}
