import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExtensionFixture } from "../tests/fixtures/core-extension/host.mjs";
import { root, run } from "./third-party/posix/common.mjs";
import { desktopHostFile } from "./desktop-host.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "darwin");
const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-mac-links-"));
const bundle = path.join(directory, "安全 ' 空格/JAVM.app");
const payload = path.join(bundle, "Contents/MacOS");
const receipts = path.join(directory, "receipts");
await mkdir(path.join(payload, ".tmp"), { recursive: true });
await mkdir(receipts);
await copyFile(path.join(root, "bin/javm_launcher"), path.join(payload, "JAVM"));
await copyFile(path.join(root, "bin", desktopHostFile()), path.join(payload, "JAVM-host"));
await copyFile(
  path.join(root, "node_modules/@neutralinojs/lib/dist/neutralino.js"),
  path.join(payload, "neutralino.js"),
);
await writeFile(
  path.join(bundle, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>net.ddmoyu.javm</string><key>CFBundleName</key><string>JAVM Safe Fixture</string><key>CFBundleExecutable</key><string>JAVM</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>javm</string></array><key>CFBundleURLName</key><string>JAVM Safe Links</string></dict></array></dict></plist>`,
);
await writeFile(
  path.join(payload, "neutralino.config.json"),
  JSON.stringify({
    applicationId: "net.ddmoyu.javm.protocolfixture",
    defaultMode: "window",
    url: "/index.html",
    documentRoot: "/",
    port: 0,
    enableServer: true,
    enableNativeAPI: true,
    enableExtensions: false,
    exportAuthInfo: true,
    dataLocation: "app",
    storageLocation: "app",
    tokenSecurity: "one-time",
    logging: { enabled: false },
    nativeAllowList: ["app.exit", "filesystem.writeFile"],
    modes: {
      window: {
        title: "Safe URL fixture",
        hidden: true,
        skipTaskbar: true,
        useSavedState: false,
        injectGlobals: true,
        newWindowPolicy: "custom",
      },
    },
  }),
);
await writeFile(
  path.join(payload, "index.html"),
  `<!doctype html><title>Safe links</title><script src="/__neutralino_globals.js"></script><script src="/neutralino.js"></script><script>
Neutralino.events.on('ready',async()=>{
 const links=NL_ARGS.filter(value=>value.startsWith('javm://safe-fixture/'));
 for(const link of links){const key=new URL(link).pathname.slice(1);if(['cold','warm'].includes(key))await Neutralino.filesystem.writeFile(${JSON.stringify(receipts)}+'/'+key+'.json',JSON.stringify({link,pid:NL_PID}));}
 await Neutralino.filesystem.writeFile(${JSON.stringify(receipts)}+'/host-'+NL_PID+'.json',JSON.stringify({pid:NL_PID,port:NL_PORT,token:NL_TOKEN,connectToken:NL_CONNECT_TOKEN}));
 if(links.length||NL_ARGS.includes('--window-hidden'))await Neutralino.app.exit();
});Neutralino.init();</script>`,
);
await run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
const host = new ExtensionFixture(
  path.join(root, "bin/javm_database"),
  path.join(directory, "unused.sqlite3"),
);
const owned = new Set();
const clients = [];
async function until(read) {
  for (let index = 0; index < 200; index++) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error("macOS 链接事件验证超时");
}
async function receipt(name) {
  return until(async () => {
    try {
      return JSON.parse(await readFile(path.join(receipts, name), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return;
      throw error;
    }
  });
}
try {
  await host.start();
  const entry = path.join(payload, "JAVM");
  const old = await host.request("platform.protocol", { operation: "status", entry });
  assert.equal(
    (
      await host.request("platform.protocol", {
        operation: "register",
        entry,
        expected: old.command,
      })
    ).state,
    "current",
  );
  assert.equal(
    (await host.request("platform.protocol", { operation: "status", entry })).state,
    "current",
  );
  // Finder/LaunchServices sends Apple Events, rather than passing URL arguments.
  await run("open", ["-a", bundle, "javm://safe-fixture/cold"]);
  assert.equal((await receipt("cold.json")).link, "javm://safe-fixture/cold");
  // A cold event may arrive before didFinishLaunching. Relaunch an idle primary
  // if it exited with that first URL, then exercise an event on an existing APP.
  await delay(1200);
  await run("open", ["-a", bundle]);
  const auth = await until(async () => {
    try {
      for (const file of await readdir(receipts)) {
        if (!/^host-\d+\.json$/.test(file)) continue;
        const value = JSON.parse(await readFile(path.join(receipts, file), "utf8"));
        try {
          process.kill(value.pid, 0);
          const response = await fetch(`http://127.0.0.1:${value.port}/index.html`, {
            signal: AbortSignal.timeout(500),
          });
          if (!response.ok) continue;
          owned.add(value.pid);
          return { nlPort: value.port, nlToken: value.token, nlConnectToken: value.connectToken };
        } catch {
          /* A completed URL delivery host is expected to have exited. */
        }
      }
    } catch {
      return;
    }
  });
  await run("open", ["javm://safe-fixture/warm"]);
  assert.equal((await receipt("warm.json")).link, "javm://safe-fixture/warm");
  const socket = new WebSocket(
    `ws://127.0.0.1:${auth.nlPort}/?connectToken=${encodeURIComponent(auth.nlConnectToken)}`,
  );
  clients.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      id: crypto.randomUUID(),
      method: "app.exit",
      accessToken: auth.nlToken,
      data: { code: 0 },
    }),
  );
  await until(async () => {
    for (const pid of owned) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    return true;
  });
  console.log("macOS: APP 注册、冷启动和运行期间的系统 URL 事件通过");
} finally {
  for (const socket of clients) socket.close();
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
  }
  await host.close();
  assert.match(path.basename(directory), /^javm-safe-mac-links-/);
  await rm(directory, { recursive: true, force: true });
}
