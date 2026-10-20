import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import react from "@vitejs/plugin-react";

if (process.platform !== "win32")
  throw new Error("This fixture verifies Windows privacy behavior.");
const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const root = await fs.mkdtemp(path.join(project, ".tmp/privacy-safe-"));
const token = path.basename(root).replaceAll("-", "");
const extension = `jpv${token.slice(-6).toLowerCase()}`;
const directory = path.join(root, "safe-media");
await fs.mkdir(directory);
await fs.mkdir(path.join(root, "resources"));
await fs.copyFile(path.join(project, "resources/icon.png"), path.join(root, "resources/icon.png"));
const file = path.join(directory, `safe-${token}.${extension}`);
execFileSync(
  process.env.JAVM_FIXTURE_FFMPEG || "ffmpeg.exe",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "120",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    file,
  ],
  { windowsHide: true, timeout: 60000 },
);
const external = path.join(root, "safe-external-probe.exe");
const probeSource = path.join(root, "probe.cs");
await fs.writeFile(
  probeSource,
  `using System; using System.IO; using System.Text; using System.Threading; using System.Runtime.InteropServices;
public static class SafePrivacyProbe {
 [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterHotKey(IntPtr w, int id, uint modifiers, uint key);
 [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr w, int id);
 [STAThread] public static void Main(string[] args) {
  string root=AppDomain.CurrentDomain.BaseDirectory;
  if(args.Length==2 && args[0]=="--reserve") {
   uint key=UInt32.Parse(args[1]); bool ok=RegisterHotKey(IntPtr.Zero, 91, 0x4000, key);
   File.WriteAllText(Path.Combine(root,"hotkey-probe.json"), ok?"true":"false");
   if(ok) { try { for(int i=0;i<18000 && !File.Exists(Path.Combine(root,"stop-hotkey"));i++) Thread.Sleep(100); } finally { UnregisterHotKey(IntPtr.Zero,91); } }
  } else File.WriteAllLines(Path.Combine(root,"external-arguments.txt"), args, new UTF8Encoding(false));
 }
}`,
);
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    `Add-Type -Path ${literal(probeSource)} -OutputAssembly ${literal(external)} -OutputType WindowsApplication`,
  ],
  { windowsHide: true, timeout: 30000 },
);
await fs.writeFile(
  path.join(root, "fixture.json"),
  JSON.stringify({
    file: file.replaceAll("\\", "/"),
    directory: directory.replaceAll("\\", "/"),
    external: external.replaceAll("\\", "/"),
    extension,
  }),
);
await build({
  configFile: false,
  root: path.join(project, "tests/fixtures/privacy"),
  publicDir: false,
  plugins: [react()],
  build: { outDir: path.join(root, "app"), emptyOutDir: true },
  logLevel: "error",
});
await fs
  .copyFile(path.join(project, "resources/logo.png"), path.join(root, "app/logo.png"))
  .catch(() => {});
const config = JSON.parse(await fs.readFile(path.join(project, "neutralino.config.json"), "utf8"));
Object.assign(config, {
  applicationId: `net.ddmoyu.javm.privacy.${token}`,
  documentRoot: "/app/",
  url: "/",
  dataLocation: "app",
  storageLocation: "app",
  exportAuthInfo: false,
  extensions: [
    {
      id: "net.ddmoyu.javm.database",
      commandWindows: `"${path.join(project, "bin/javm_database.exe")}" --database "${path.join(root, "data/downloads-v1.sqlite3")}"`,
    },
  ],
});
config.nativeAllowList.push("window.isVisible", "window.snapshot");
Object.assign(config.modes.window, {
  title: "JAVM 隐私保护安全验收",
  width: 1100,
  height: 900,
  borderless: false,
  useSavedState: false,
  exitProcessOnClose: false,
});
await fs.writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
const args = ["--res-mode=directory", `--path=${root.replaceAll("\\", "/")}`];
const hostBinary = path.join(project, "bin/neutralino-win_x64.exe");
const launch = (extra = []) =>
  spawn(hostBinary, [...args, ...extra], { windowsHide: true, stdio: "ignore" });
let host = launch();
const neutral = launch(["--enable-extensions=false", "--url=/?neutral=1"]);
const conflict = spawn(external, ["--reserve", "119"], { windowsHide: true, stdio: "ignore" }); // F8
const metadata = () =>
  fs.writeFile(
    path.join(root, "launch.json"),
    JSON.stringify({
      root,
      mainPid: host.pid,
      neutralPid: neutral.pid,
      conflictPid: conflict.pid,
      extension,
      file,
    }),
  );
await metadata();
console.log(`Privacy safe fixture: ${root}`);
console.log(
  `Main PID ${host.pid}, neutral PID ${neutral.pid}; only generated media and an isolated database.`,
);
let restarted;
try {
  const deadline = Date.now() + 45 * 60000;
  while (Date.now() < deadline && !(await fs.stat(path.join(root, "stop")).catch(() => null))) {
    const request = await fs
      .readFile(path.join(root, "restart.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (request?.id && request.id !== restarted && host.exitCode !== null) {
      restarted = request.id;
      host = launch();
      await metadata();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} finally {
  await fs.writeFile(path.join(root, "stop-hotkey"), "stop");
  // 只清理此次明确启动的宿主；播放器通过主窗口关闭流程退出。
  if (host.exitCode === null) host.kill();
  if (neutral.exitCode === null) neutral.kill();
  if (conflict.exitCode === null) conflict.kill();
}
