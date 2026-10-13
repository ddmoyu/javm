import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, readJson, safePath, sha256 } from "./third-party/components.mjs";
import { releaseAssetNames } from "./release-notes.mjs";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("安装包构建需要 Windows x64");
const pkg = await readJson(path.join(root, "package.json"));
const bundle = await readJson(path.join(root, "dist/offline/latest.json"));
const manifestBytes = await readFile(bundle.manifest);
const manifest = JSON.parse(manifestBytes);
if (
  sha256(manifestBytes) !== bundle.manifestSha256 ||
  manifest.version !== pkg.version ||
  manifest.platform !== "windows-x64" ||
  manifest.entryPoint !== "JAVM.exe" ||
  !manifest.files?.length
)
  throw new Error("安装包输入与当前版本的便携包清单不匹配，请先重新打包");

const candidates = process.env.JAVM_ISCC
  ? [process.env.JAVM_ISCC]
  : [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
      .filter(Boolean)
      .map((directory) => path.join(directory, "Inno Setup 6", "ISCC.exe"));
let compiler;
for (const candidate of candidates) {
  if (
    await access(candidate).then(
      () => true,
      () => false,
    )
  ) {
    compiler = candidate;
    break;
  }
}
if (!compiler) throw new Error("需要 Inno Setup 6；也可通过 JAVM_ISCC 指定 ISCC.exe");

const output = path.join(root, "build/installer");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(path.join(output, "payload-"));
if (path.dirname(stage) !== output || !path.basename(stage).startsWith("payload-"))
  throw new Error("安装包暂存目录超出构建目录");
const payload = path.join(stage, "app");
const name = releaseAssetNames(pkg.version).setup;
const installer = path.join(output, name);
// 失败后不能误用同名旧安装包或验证记录。
await rm(path.join(output, "latest.json"), { force: true });
await rm(installer, { force: true });
try {
  const seen = new Set();
  for (const file of manifest.files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("重复的运行文件：" + file.path);
    seen.add(key);
    const target = safePath(payload, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(safePath(bundle.directory, file.path), target);
    const bytes = await readFile(target);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw new Error("安装包运行文件校验失败：" + file.path);
  }
  if (!seen.has("javm.exe")) throw new Error("安装包缺少 JAVM.exe");
  const notices = path.join(stage, "THIRD-PARTY-NOTICES.txt");
  await writeFile(
    notices,
    manifest.licenseNotices
      .map((notice) => notice.components.join(" / ") + "\n" + "=".repeat(72) + "\n" + notice.text)
      .join("\n\n"),
  );
  const numeric = pkg.version.replace("-alpha.", ".");
  const compilation = execFileSync(
    compiler,
    [
      "/Qp",
      `/DAppVersion=${pkg.version}`,
      `/DNumericVersion=${numeric}`,
      `/DProjectRoot=${root}`,
      `/DPayloadDirectory=${payload}`,
      `/DNoticesFile=${notices}`,
      `/DOutputDirectory=${output}`,
      `/DOutputName=${name.replace(/\.exe$/, "")}`,
      path.join(root, "scripts/installer/javm.iss"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 180000 },
  );
  const bytes = await readFile(installer);
  const receipt = {
    version: pkg.version,
    platform: manifest.platform,
    commit: manifest.source.commit,
    dirty: manifest.source.dirty,
    appId: "net.ddmoyu.javm.neutralino",
    installer,
    name,
    bytes: bytes.length,
    sha256: sha256(bytes),
    portableArchiveSha256: bundle.sha256,
    manifestSha256: bundle.manifestSha256,
    compilerSha256: sha256(await readFile(compiler)),
    compilation: compilation.trim(),
  };
  await writeFile(path.join(output, "latest.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ installer, bytes: receipt.bytes, sha256: receipt.sha256 }));
} finally {
  await rm(stage, { recursive: true, force: true });
}
