import { describe, expect, it } from "vite-plus/test";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_DOWNLOAD_INTEGRATION === "1";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.runIf(enabled)("real Neutralino host lifecycle", () => {
  it("releases the extension after host death and preserves committed SQLite data", async () => {
    const root = await fs.mkdtemp(path.join(project, ".tmp/download-host-"));
    const database = path.join(root, "downloads.sqlite3");
    const executable = path.join(root, "javm_database.exe");
    await fs.copyFile(path.join(project, "bin/javm_database.exe"), executable);
    await fs.copyFile(path.join(project, "bin/MediaInfo.dll"), path.join(root, "MediaInfo.dll"));
    await fs.mkdir(path.join(root, "app"));
    await fs.writeFile(
      path.join(root, "app/index.html"),
      "<!doctype html><title>Lifecycle fixture</title>",
    );
    await fs.writeFile(
      path.join(root, "neutralino.config.json"),
      JSON.stringify({
        applicationId: `net.ddmoyu.javm.test.${crypto.randomUUID().replaceAll("-", "")}`,
        defaultMode: "cloud",
        port: 0,
        documentRoot: "/app/",
        url: "/",
        enableServer: true,
        enableNativeAPI: true,
        enableExtensions: true,
        exportAuthInfo: true,
        dataLocation: "app",
        storageLocation: "app",
        tokenSecurity: "one-time",
        logging: { enabled: true },
        nativeAllowList: ["app.broadcast", "extensions.dispatch"],
        extensions: [
          {
            id: "net.ddmoyu.javm.database",
            commandWindows: `"${executable}" --database "${database}" 2>"${path.join(root, "extension.stderr")}"`,
          },
        ],
      }),
    );
    const host = spawn(
      path.join(project, "bin/neutralino-win_x64.exe"),
      ["--mode=cloud", "--res-mode=directory", `--path=${root}`],
      { windowsHide: true },
    );
    const closed = new Promise<void>((resolve) => host.once("close", () => resolve()));
    let diagnostics = "";
    host.stderr.on("data", (bytes: Buffer) => {
      diagnostics = (diagnostics + bytes.toString()).slice(-4000);
    });
    const authFile = path.join(root, ".tmp/auth_info.json");
    let socket: WebSocket | undefined;
    try {
      let auth: { nlPort: string; nlToken: string; nlConnectToken: string } | undefined;
      for (let i = 0; i < 100; ++i) {
        const raw = await fs.readFile(authFile, "utf8").catch(() => null);
        if (raw) {
          auth = JSON.parse(raw) as NonNullable<typeof auth>;
          break;
        }
        if (host.exitCode !== null) throw new Error(`Fixture host exited ${host.exitCode}`);
        await delay(100);
      }
      if (!auth) throw new Error("Fixture authentication was not exported");
      socket = new WebSocket(
        `ws://127.0.0.1:${auth.nlPort}/?connectToken=${encodeURIComponent(auth.nlConnectToken)}`,
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Host connection timeout")), 5000);
        socket!.addEventListener(
          "open",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        socket!.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error("Host connection failed"));
          },
          { once: true },
        );
      });
      for (let i = 0; i < 50 && !(await fs.stat(database).catch(() => null)); ++i) await delay(100);
      if (!(await fs.stat(database).catch(() => null))) {
        const extensionError = await fs
          .readFile(path.join(root, "extension.stderr"), "utf8")
          .catch(() => "");
        throw new Error(`Database did not open: ${diagnostics} ${extensionError}`);
      }
      const requestId = crypto.randomUUID();
      const saved = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Database save timeout")), 5000);
        socket!.addEventListener("message", (message) => {
          const reply = JSON.parse(String(message.data)) as {
            event?: string;
            data?: { requestId?: string; ok?: boolean; error?: string };
          };
          if (reply.event !== "javm.database.response" || reply.data?.requestId !== requestId)
            return;
          clearTimeout(timeout);
          if (reply.data.ok) resolve();
          else reject(new Error(reply.data.error));
        });
      });
      socket.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          method: "extensions.dispatch",
          accessToken: auth.nlToken,
          data: {
            extensionId: "net.ddmoyu.javm.database",
            event: "javm.database.request",
            data: {
              requestId,
              protocol: 1,
              method: "downloads.settings",
              params: { directory: root, concurrency: 3 },
            },
          },
        }),
      );
      await saved;
      host.kill();
      const exited = await Promise.race([closed.then(() => true), delay(8000).then(() => false)]);
      expect(exited, "The isolated host must exit").toBe(true);
      for (let i = 0; i < 80 && (await fs.stat(`${database}.owner.lock`).catch(() => null)); ++i)
        await delay(100);
      await expect(fs.stat(`${database}.owner.lock`)).rejects.toThrow();
      const db = new DatabaseSync(database);
      try {
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("SELECT payload FROM download_settings WHERE id = 1").get()).toEqual({
          payload: JSON.stringify({ concurrency: 3, directory: root }),
        });
        db.exec("BEGIN EXCLUSIVE; ROLLBACK;");
      } finally {
        db.close();
      }
    } finally {
      socket?.close();
      if (host.exitCode === null) host.kill();
      // Only this fixture's copied executable is eligible for failure cleanup.
      const literal = executable.replaceAll("'", "''");
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name = 'javm_database.exe'" | Where-Object { $_.ExecutablePath -eq '${literal}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      await fs.rm(authFile, { force: true });
    }
  }, 25000);
});
