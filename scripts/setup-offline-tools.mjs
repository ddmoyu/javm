import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const command = process.platform === "win32" ? "powershell.exe" : process.execPath;
const args =
  process.platform === "win32"
    ? [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/setup-offline-tools.ps1"),
      ]
    : [path.join(root, "scripts/third-party/posix/resolve.mjs")];
const child = spawn(command, [...args, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
