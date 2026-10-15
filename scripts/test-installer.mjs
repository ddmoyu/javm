// 本次安装器专项：仅打包安全的文本占位文件，不启动应用或读取个人数据。
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { root, readJson, sha256 } from "./third-party/components.mjs";

if (process.platform !== "win32") throw new Error("安装器专项需要 Windows");
const compiler =
  process.env.JAVM_ISCC ?? path.join(process.env["ProgramFiles(x86)"], "Inno Setup 6/ISCC.exe");
const { version } = await readJson(path.join(root, "package.json"));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const base = await mkdtemp(path.join(root, ".tmp/installer-fixture-"));
const payload = path.join(base, "payload");
const files = [];
for (const relative of ["JAVM.exe", "bin/javm_database.exe", "bin/tools/safe-fixture.txt"]) {
  const data = Buffer.from("Safe installer fixture, never execute: " + relative);
  const target = path.join(payload, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  files.push({ path: relative, bytes: data.length, sha256: sha256(data) });
}
const manifest = path.join(base, "manifest.json");
const manifestBytes = JSON.stringify({ version, files });
await writeFile(manifest, manifestBytes);
const bundle = { manifest, manifestSha256: sha256(manifestBytes), sha256: null };
const bundlePath = path.join(base, "bundle.json");
await writeFile(bundlePath, JSON.stringify(bundle));
const notices = path.join(base, "notices.txt");
await writeFile(notices, "Safe synthetic installer fixture; no application or media data.\n");
const identifier = randomUUID().slice(0, 8);
const appId = "net.ddmoyu.javm.neutralino.validation." + identifier;
const group = "JAVM validation " + identifier;
execFileSync(
  compiler,
  [
    "/Qp",
    `/DAppVersion=${version}`,
    `/DNumericVersion=${version.replace("-alpha.", ".")}`,
    `/DJavmAppId=${appId}`,
    `/DJavmGroup=${group}`,
    `/DProjectRoot=${root}`,
    `/DPayloadDirectory=${payload}`,
    `/DNoticesFile=${notices}`,
    `/DOutputDirectory=${base}`,
    "/DOutputName=fixture-setup",
    path.join(root, "scripts/installer/javm.iss"),
  ],
  { windowsHide: true, stdio: "pipe", timeout: 120000 },
);
const installer = path.join(base, "fixture-setup.exe");
const receipt = path.join(base, "receipt.json");
await writeFile(
  receipt,
  JSON.stringify({
    version,
    appId,
    group,
    installer,
    sha256: sha256(await readFile(installer)),
    manifestSha256: bundle.manifestSha256,
    portableArchiveSha256: null,
  }),
);
execFileSync(
  "pwsh.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "scripts/verify-installer.ps1"),
    "-ReceiptPath",
    receipt,
    "-BundlePath",
    bundlePath,
    "-ReportPath",
    path.join(base, "verification.json"),
  ],
  { windowsHide: true, stdio: "inherit", timeout: 300000 },
);
