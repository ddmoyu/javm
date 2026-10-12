import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const offlinePackage = process.env.JAVM_OFFLINE_PACKAGE;
await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
const root = await fs.mkdtemp(path.join(project, ".tmp/metadata-desktop-"));
const resultPath = path.join(root, "result.json");
const requests = [];
const server = createServer((request, response) => {
  const send = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/oversize") {
    response.writeHead(200, { "Content-Length": 2 * 1024 * 1024 });
    response.end("x".repeat(2 * 1024 * 1024));
    return;
  }
  if (url.pathname === "/slow") {
    const timer = setTimeout(() => send({ ok: true }), 20000);
    response.on("close", () => clearTimeout(timer));
    return;
  }
  if (
    url.pathname.startsWith("/v1/") &&
    request.headers.authorization !== "Bearer fixture-secret"
  ) {
    send({ error: "unauthorized" }, 401);
    return;
  }
  if (url.pathname === "/v1/db/version") {
    send({ data: "1.0.0" });
    return;
  }
  if (url.pathname === "/v1/providers") {
    send({ data: { movie_providers: { Fixture: "https://example.invalid" } } });
    return;
  }
  if (url.pathname === "/v1/movies/search") {
    requests.push({ kind: "search", query: url.searchParams.get("q") });
    send({
      data: [
        { provider: "Fixture", id: "test/001", number: "TEST-001", title: "Fictional sample film" },
      ],
    });
    return;
  }
  if (url.pathname === "/v1/movies/Fixture/test%2F001") {
    send({
      data: {
        provider: "Fixture",
        id: "test/001",
        number: "TEST-001",
        title: "Fictional sample film",
        summary: "A peaceful journey through a fictional city.",
        actors: ["虚构角色甲"],
        genres: ["测试分类"],
        runtime: 90,
      },
    });
    return;
  }
  if (url.pathname === "/v1/chat/completions") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ kind: "ai", model: body.model, messages: body.messages });
        const system = body.messages[0].content;
        const answer = system.includes("Extract")
          ? { code: "TEST-001" }
          : system.includes("Translate")
            ? { title: "虚构示例影片", plot: "穿过虚构城市的一段平静旅程。" }
            : { ok: true };
        send({
          choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
        });
      } catch {
        send({ error: "bad fixture request" }, 400);
      }
    });
    return;
  }
  send({ error: "not found" }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(root, "fixture.json"), JSON.stringify({ base }));
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/metadata"),
  publicDir: path.join(project, "resources"),
  plugins: [react()],
  build: { outDir: path.join(root, "app"), emptyOutDir: true },
  logLevel: "error",
});
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
const params = new URLSearchParams({
  result: resultPath,
  fixture: path.join(root, "fixture.json"),
  root,
});
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.metadatatest.${crypto.randomUUID()}`,
  enableExtensions: false,
  extensions: [],
  documentRoot: "/app/",
  url: `/?${params}`,
  dataLocation: "app",
  storageLocation: "app",
});
config.nativeAllowList.push("window.snapshot");
config.modes.window = {
  ...config.modes.window,
  title: "JAVM 资料服务验证",
  width: 1024,
  height: 800,
  useSavedState: false,
  borderless: false,
  exitProcessOnClose: true,
};
await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
// Desktop validation always uses the supplied package or prepared build dependencies.
await fs.cp(path.join(offlinePackage || project, "bin/tools"), path.join(root, "bin/tools"), {
  recursive: true,
});
const hostEnv = {
  ...process.env,
  // Keep concurrent desktop tests from sharing a WebView2 browser process.
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview-profile"),
};
if (offlinePackage) {
  delete hostEnv.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
  hostEnv.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`;
}
const hostBinary = offlinePackage
  ? path.join(
      offlinePackage,
      (await fs.stat(path.join(offlinePackage, "javm-win_x64.exe")).catch(() => null))?.isFile()
        ? "javm-win_x64.exe"
        : "JAVM.exe",
    )
  : path.join(project, "bin/neutralino-win_x64.exe");
const host = spawn(hostBinary, ["--res-mode=directory", `--path=${root.replaceAll("\\", "/")}`], {
  windowsHide: true,
  stdio: "ignore",
  env: hostEnv,
});
console.log(`Metadata desktop test: ${root}`);
try {
  let report;
  const deadline = Date.now() + 420000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    report = await fs
      .readFile(resultPath, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (report?.done || host.exitCode !== null) break;
  }
  if (report?.done && report.exitProcessPath) {
    const expectedPath = path.join(root, "bin/tools/metatube/metatube-server.exe");
    if (path.resolve(report.exitProcessPath) !== expectedPath)
      throw new Error("拒绝检查测试目录以外的 MetaTube 进程");
    const command = `$javmTarget='${expectedPath.replaceAll("'", "''")}'; @(Get-CimInstance Win32_Process -Filter "Name='metatube-server.exe'" | Where-Object { $_.ExecutablePath -eq $javmTarget }).Count`;
    let remaining = -1;
    const exitDeadline = Date.now() + 15000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 500));
      remaining = Number(
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 10000,
        }).trim(),
      );
    } while ((remaining !== 0 || host.exitCode === null) && Date.now() < exitDeadline);
    report.results.push({
      name: "主程序退出后监督器回收仍在运行的 MetaTube",
      ok: remaining === 0 && host.exitCode !== null,
      detail: `宿主退出码 ${host.exitCode}，残留 MetaTube 进程 ${remaining}`,
    });
    await fs.writeFile(resultPath, JSON.stringify(report, null, 2));
  }
  await fs.writeFile(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (
    !report?.done ||
    report.fatal ||
    report.exceptions.length ||
    report.results.some((result) => !result.ok)
  )
    process.exitCode = 1;
} finally {
  if (host.exitCode === null) {
    // 仅终止本测试创建的宿主树，包含测试失败时仍在运行的工具。
    execFileSync("taskkill.exe", ["/PID", String(host.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
