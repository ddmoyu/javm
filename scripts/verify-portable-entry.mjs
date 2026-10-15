import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Cloud mode creates no window and never executes the production frontend.
// Extensions are disabled; state belongs to newly created fixture folders.
const project = path.resolve(import.meta.dirname, "..");
const bundle = JSON.parse(await readFile(path.join(project, "dist/offline/latest.json"), "utf8"));
assert.equal(bundle.entryPoint, "JAVM.exe");
const base = await mkdtemp(path.join(project, ".tmp/portable-entry-"));
const cwd = path.join(base, "工作目录");
await mkdir(cwd);
const reports = [];
for (const mode of ["embedded", "directory", "override"]) {
  const app = path.join(base, "程序 " + mode);
  const resources = mode === "override" ? path.join(base, "隐藏读取 资源") : app;
  await mkdir(app);
  await mkdir(resources, { recursive: true });
  const executable = path.join(app, "JAVM.exe");
  await copyFile(path.join(bundle.directory, bundle.entryPoint), executable);
  if (mode !== "embedded") {
    await mkdir(path.join(resources, "mock"));
    await writeFile(
      path.join(resources, "mock/index.html"),
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Safe fixture</title><p>SAFE_PORTABLE_ENTRY</p>',
    );
    await writeFile(
      path.join(resources, "neutralino.config.json"),
      JSON.stringify({
        applicationId: "net.ddmoyu.javm.safeentry." + crypto.randomUUID(),
        documentRoot: "/mock/",
        url: "/",
        port: 0,
        enableServer: true,
        enableNativeAPI: true,
        enableExtensions: false,
        nativeAllowList: ["app.getConfig", "app.exit"],
        logging: { enabled: false },
      }),
    );
  }
  const child = spawn(
    executable,
    [
      "--mode=cloud",
      "--enable-extensions=false",
      "--data-location=app",
      "--storage-location=app",
      "--export-auth-info=true",
      "--logging-enabled=false",
      ...(mode === "embedded" ? [] : ["--res-mode=directory"]),
      ...(mode === "override" ? ["--path=" + resources.replaceAll("\\", "/")] : []),
    ],
    { cwd, windowsHide: true, stdio: "ignore" },
  );
  let spawnError;
  child.once("error", (error) => (spawnError = error));
  const wait = async (read, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    do {
      if (spawnError) throw spawnError;
      const result = await read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error("Portable entry timed out: " + mode);
  };
  let socket;
  try {
    const auth = await wait(() =>
      readFile(path.join(resources, ".tmp/auth_info.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null),
    );
    const response = await fetch("http://127.0.0.1:" + auth.nlPort + "/", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(mode === "embedded" ? 'id="root"' : "SAFE_PORTABLE_ENTRY"));
    socket = new WebSocket(
      "ws://127.0.0.1:" + auth.nlPort + "/?connectToken=" + auth.nlConnectToken,
    );
    socket.addEventListener("error", () => {});
    await wait(() => socket.readyState === WebSocket.OPEN);
    const id = crypto.randomUUID();
    let reply;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === id) reply = message.data;
    });
    socket.send(
      JSON.stringify({ id, method: "app.getConfig", data: {}, accessToken: auth.nlToken }),
    );
    await wait(() => reply);
    assert.equal(reply.success, true);
    assert.equal(reply.returnValue.defaultMode, "cloud");
    assert.equal(reply.returnValue.enableExtensions, false);
    socket.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        method: "app.exit",
        data: {},
        accessToken: auth.nlToken,
      }),
    );
    await wait(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
    reports.push({ mode, launchedFromOtherDirectory: true, exited: true });
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      child.kill();
      await wait(() => child.exitCode !== null || child.signalCode !== null, 5000);
    }
  }
}
await writeFile(path.join(base, "result.json"), JSON.stringify({ reports }, null, 2));
console.log(JSON.stringify({ fixture: base, reports, windowsCreated: 0 }, null, 2));
