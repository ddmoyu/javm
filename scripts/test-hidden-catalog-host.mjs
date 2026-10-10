import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite-plus";

const project = path.resolve(import.meta.dirname, "..");
const proxyProbe = process.argv.includes("--proxy-probe");
let proxy = process.env.JAVM_SAFE_PROXY || "";
if (proxyProbe) {
  const value = new URL(proxy);
  if (
    !["http:", "https:", "socks5:"].includes(value.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) ||
    value.username ||
    value.password ||
    value.pathname !== "/" ||
    value.search ||
    value.hash
  )
    throw new Error("JAVM_SAFE_PROXY must be an unauthenticated local proxy URL");
}
const root = await mkdtemp(path.join(project, ".tmp/隐藏读取-"));
await mkdir(path.join(root, "temp"));
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/hidden-catalog-host"),
  build: { outDir: path.join(root, "app"), emptyOutDir: true },
  logLevel: "error",
});
const bundle = JSON.parse(await readFile(path.join(project, "dist/offline/latest.json"), "utf8"));
const config = JSON.parse(await readFile(path.join(project, "neutralino.config.json"), "utf8"));
const blockedRequests = { sourceRequests: 0, sourceTunnels: 0, other: 0 };
function recordBlockedRequest(request) {
  let source = false;
  try {
    const url = new URL(request.method === "CONNECT" ? `https://${request.url}` : request.url);
    source = url.hostname === "avwikidb.com" || url.hostname.endsWith(".avwikidb.com");
  } catch {}
  blockedRequests[
    source ? (request.method === "CONNECT" ? "sourceTunnels" : "sourceRequests") : "other"
  ]++;
}
const mockProxy = createServer((request, response) => {
  recordBlockedRequest(request);
  response.writeHead(502);
  response.end();
});
mockProxy.on("connect", (request, socket) => {
  recordBlockedRequest(request);
  socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
});
await new Promise((resolve) => mockProxy.listen(0, "127.0.0.1", resolve));
if (!proxyProbe) proxy = `http://127.0.0.1:${mockProxy.address().port}`;
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.safehost.${crypto.randomUUID()}`,
  documentRoot: "/app/",
  url: proxyProbe ? "/?mode=proxy" : "/",
  globalVariables: { SAFE_PROXY: proxy },
  dataLocation: "app",
  storageLocation: "app",
  enableExtensions: false,
  extensions: [],
  systemEnvs: { TEMP: path.join(root, "temp"), TMP: path.join(root, "temp") },
  logging: { enabled: false },
});
if (process.argv.includes("--system-temp")) delete config.systemEnvs;
Object.assign(config.modes.window, {
  title: "安全隐藏读取验证",
  hidden: true,
  skipTaskbar: true,
  useSavedState: false,
  exitProcessOnClose: true,
  webviewArgs:
    '--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1" --disable-background-networking --no-proxy-server --mute-audio --blink-settings=imagesEnabled=false',
});
await writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
await writeFile(
  path.join(root, "launch.ps1"),
  await readFile(path.join(project, "frontend/src/platform/neutralino/hiddenProcess.ps1")),
);
await writeFile(
  path.join(root, "launch.json"),
  JSON.stringify({
    file: path.join(bundle.directory, "javm-win_x64.exe"),
    arguments: `--res-mode=directory --path="${root.replaceAll("\\", "/")}"`,
    profile: path.join(root, "profile"),
    ownerPid: process.pid,
    timeoutMs: 45000,
  }),
);
const launcher = spawn(
  path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "launch.ps1"),
    "-Config",
    path.join(root, "launch.json"),
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let processOutput = "";
launcher.stdout.on("data", (data) => {
  processOutput = (processOutput + String(data)).slice(-4000);
});
launcher.stderr.on("data", (data) => {
  processOutput = (processOutput + String(data)).slice(-4000);
});
let exited = false;
const exit = new Promise((resolve) =>
  launcher.once("exit", (code) => {
    exited = true;
    resolve(code);
  }),
);
console.log(`Safe packaged host: ${root}`);
try {
  const deadline = Date.now() + 45000;
  let result;
  while (!exited && Date.now() < deadline) {
    result = await readFile(path.join(root, "result.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (result?.done) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  result = await readFile(path.join(root, "result.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  console.log(JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ blockedRequests }));
  if (processOutput) console.log(processOutput);
  const correctResult = proxyProbe
    ? result?.proxyStatus === 204
    : JSON.stringify(result?.codes) === '["TEST-001","TEST-002"]';
  if (
    !result?.done ||
    result.error ||
    !correctResult ||
    blockedRequests.sourceRequests ||
    JSON.stringify(result.hostStages) !== '["launch","connect","read"]'
  )
    throw new Error("Packaged host hidden read failed");
  await exit;
} finally {
  if (!exited) launcher.kill();
  await exit;
  mockProxy.closeAllConnections();
  await new Promise((resolve) => mockProxy.close(resolve));
}
