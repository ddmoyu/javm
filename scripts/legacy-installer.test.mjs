// 只安装文本占位程序，注册表使用随机验证键，绝不启动应用或读取个人数据。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

test(
  "旧 Tauri 参数交接原安装目录，保留用户文件并替换卸载入口",
  { skip: process.platform !== "win32" },
  async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const base = await mkdtemp(path.join(root, ".tmp/legacy-update-safe-")),
      id = randomUUID().slice(0, 8);
    const legacyKey = `Software\\JAVM\\LegacyUpdateValidation\\${id}`;
    const appId = "net.ddmoyu.javm.neutralino.validation." + id;
    const newKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`;
    const directory = path.join(base, "legacy application"),
      payload = path.join(base, "payload"),
      unintended = path.join(base, "ignored app argument");
    const exec = (file, args, timeout = 120000) =>
      execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout,
      });
    const reg = (args) => exec("reg.exe", args);
    // 随机键碰撞也拒绝覆盖。
    let exists = false;
    try {
      reg(["query", "HKCU\\" + legacyKey]);
      exists = true;
    } catch {
      /* expected absent */
    }
    assert.equal(exists, false);
    await mkdir(directory);
    await mkdir(payload);
    await writeFile(path.join(directory, "javm.exe"), "safe old application placeholder");
    await writeFile(path.join(directory, "uninstall.exe"), "safe old uninstaller placeholder");
    await writeFile(path.join(directory, "user-data.txt"), "safe fictional user data");
    await writeFile(path.join(payload, "JAVM.exe"), "safe new application placeholder");
    await writeFile(path.join(base, "notices.txt"), "safe fixture");
    const compiler =
      process.env.JAVM_ISCC ?? path.join(process.env["ProgramFiles(x86)"], "Inno Setup 6/ISCC.exe");
    exec(compiler, [
      "/Qp",
      "/DAppVersion=99.0.0-beta.1",
      "/DNumericVersion=99.0.0.1",
      `/DJavmAppId=${appId}`,
      `/DJavmGroup=JAVM validation ${id}`,
      `/DLegacyUninstallKey=${legacyKey}`,
      `/DProjectRoot=${root}`,
      `/DPayloadDirectory=${payload}`,
      `/DNoticesFile=${path.join(base, "notices.txt")}`,
      `/DOutputDirectory=${base}`,
      "/DOutputName=legacy-safe-setup",
      path.join(root, "scripts/installer/javm.iss"),
    ]);
    for (const [name, value] of Object.entries({
      DisplayName: "javm",
      MainBinaryName: "javm.exe",
      InstallLocation: `"${directory}"`,
    }))
      reg(["add", "HKCU\\" + legacyKey, "/v", name, "/t", "REG_SZ", "/d", value, "/f", "/reg:64"]);
    let installed = false;
    try {
      exec(path.join(base, "legacy-safe-setup.exe"), [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/SP-",
        "/P",
        "/R",
        "/UPDATE",
        "/ARGS",
        `/DIR=${unintended}`,
        `/LOG=${path.join(base, "install.log")}`,
      ]);
      installed = true;
      assert.equal(
        await readFile(path.join(directory, "JAVM.exe"), "utf8"),
        "safe new application placeholder",
      );
      assert.equal(
        await readFile(path.join(directory, "user-data.txt"), "utf8"),
        "safe fictional user data",
      );
      assert.throws(() => reg(["query", "HKCU\\" + legacyKey, "/reg:64"]));
      assert.match(
        reg(["query", newKey, "/v", "InstallLocation", "/reg:64"]),
        /legacy application/,
      );
      await assert.rejects(readFile(path.join(unintended, "JAVM.exe")));
      exec(path.join(directory, "unins000.exe"), [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
      ]);
      installed = false;
      assert.equal(
        await readFile(path.join(directory, "user-data.txt"), "utf8"),
        "safe fictional user data",
      );
    } finally {
      if (installed)
        exec(path.join(directory, "unins000.exe"), [
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
        ]);
      try {
        reg(["delete", "HKCU\\" + legacyKey, "/f", "/reg:64"]);
      } catch {
        /* successful upgrade removed it */
      }
    }
  },
);
