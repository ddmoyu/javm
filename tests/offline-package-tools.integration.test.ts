import { describe, it, expect } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const powershell = (script: string) =>
  run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from("$ErrorActionPreference='Stop'\n" + script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 20000 },
  );

describe.runIf(process.platform === "win32")("离线包校验（无安装、注册表或联网操作）", () => {
  it("安装和签名脚本语法有效", async () => {
    const files = [
      "resources/offline/Install-JAVM.ps1",
      "resources/offline/Uninstall-JAVM.ps1",
      "resources/offline/Package-Tools.ps1",
      "scripts/sign-package.ps1",
    ];
    for (const file of files)
      await powershell(
        "$tokens=$null;$errors=$null\n[void][Management.Automation.Language.Parser]::ParseFile(" +
          quote(path.resolve(file)) +
          ",[ref]$tokens,[ref]$errors)\nif ($errors.Count) { throw ($errors | Out-String) }",
      );
  }, 30000);

  it("按清单核对安全假文件，拒绝内容改动与目录穿越", async () => {
    await fs.mkdir(".tmp", { recursive: true });
    const root = path.resolve(await fs.mkdtemp(".tmp/package-tools-"));
    const content = Buffer.from("Safe fixture; this is not an executable.");
    const files = ["JAVM.exe", "javm-win_x64.exe", "bin/javm_database.exe"];
    for (const name of files) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    const manifest = {
      app: "JAVM",
      platform: "windows-x64",
      version: "1.0.0",
      files: files.map((name) => ({
        path: name,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    };
    const save = () =>
      fs.writeFile(path.join(root, "package-manifest.json"), JSON.stringify(manifest));
    const verify = () =>
      powershell(
        ". " +
          quote(path.resolve("resources/offline/Package-Tools.ps1")) +
          "\n[void](Test-JavmPackage " +
          quote(root) +
          ")",
      );
    await save();
    await expect(verify()).resolves.toBeDefined();
    await fs.appendFile(path.join(root, "JAVM.exe"), "changed");
    await expect(verify()).rejects.toThrow("Package checksum mismatch");
    await fs.writeFile(path.join(root, "JAVM.exe"), content);
    manifest.files[0]!.path = "../outside.exe";
    await save();
    await expect(verify()).rejects.toThrow("Invalid package path");
  }, 30000);
});
