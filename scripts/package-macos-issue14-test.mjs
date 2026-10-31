// Explicit diagnostic repack only. Never used by application release/resolution.
import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  inventory,
  json,
  root,
  run,
  sha256,
  specification,
  target,
  verifyInventory,
} from "./third-party/posix/common.mjs";
import { binaryArchitecture } from "./third-party/posix/verify.mjs";
import { verifyHostGlobals } from "./third-party/posix/verify-host.mjs";
import { installationReceipt } from "./update-format.mjs";

assert.equal(target, "macos-x64", "本专项包仅用于 Intel macOS");
const version = "1.0.17";
assert.equal((await json(path.join(root, "package.json"))).version, version);
const commit = await run("git", ["rev-parse", "HEAD"], root, true);
assert.match(commit, /^[a-f0-9]{40}$/);
const spec = await specification("neutralino");
const componentDirectory = path.join(root, "build/issue14-component");
const archive = path.join(componentDirectory, `${spec.tag}.tar.gz`);
const archiveHash = sha256(await readFile(archive));
assert.equal(
  (await readFile(`${archive}.sha256`, "utf8")).trim(),
  `${archiveHash}  ${spec.tag}.tar.gz`,
);
await mkdir(path.join(root, "build"), { recursive: true });
const stage = await mkdtemp(path.join(root, "build/issue14-test-"));
const component = path.join(stage, "component");
await mkdir(component);
await run("tar", ["-xzf", archive, "-C", component]);
const componentManifest = await json(path.join(component, "manifest.json"));
assert.equal(componentManifest.fingerprint, spec.fingerprint);
assert.equal(componentManifest.tag, spec.tag);
assert.equal(componentManifest.sourceCommit, commit);
assert.equal(componentManifest.platform, target);
assert.equal(componentManifest.verification.passed, true);
await verifyInventory(component, componentManifest);

// Pinned published payload; no other third-party components are rebuilt.
const baseName = `JAVM-${version}-${target}-portable.zip`;
const baseHash = "07cb380ba01ad95500971184cf78d38822903663296c9212a19e2c59f746de60";
const baseURL = `https://github.com/ddmoyu/javm/releases/download/v${version}/${baseName}`;
const response = await fetch(baseURL, { signal: AbortSignal.timeout(180000) });
assert.ok(response.ok, `基础包下载失败: ${response.status}`);
const baseBytes = Buffer.from(await response.arrayBuffer());
assert.equal(sha256(baseBytes), baseHash, "基础包 SHA256 不匹配");
const baseZip = path.join(stage, baseName);
await writeFile(baseZip, baseBytes);
await run("ditto", ["-x", "-k", baseZip, stage]);
const appName = `JAVM Issue14 Test ${commit.slice(0, 8)}.app`;
const app = path.join(stage, appName);
await rename(path.join(stage, "JAVM.app"), app);
await run("codesign", ["--verify", "--deep", "--strict", app]);
const originalFiles = await inventory(app);
const hostRelative = "Contents/MacOS/JAVM-host";
const host = path.join(app, hostRelative);
await copyFile(path.join(component, "runtime/neutralino"), host);
await chmod(host, 0o755);
assert.equal(binaryArchitecture(await readFile(host)), target);
const plist = path.join(app, "Contents/Info.plist");
for (const command of [
  "Set :CFBundleIdentifier net.ddmoyu.javm.issue14-test",
  "Set :CFBundleName JAVM Issue14 Test",
  "Set :CFBundleDisplayName JAVM 测试版",
  "Delete :CFBundleURLTypes",
])
  await run("/usr/libexec/PlistBuddy", ["-c", command, plist]);
await run("codesign", ["--force", "--sign", "-", host]);
const hostHash = sha256(await readFile(host));
const hostUUID = (await run("xcrun", ["dwarfdump", "--uuid", host], root, true)).match(
  /UUID: ([A-F0-9-]{36})/,
)?.[1];
assert.ok(hostUUID, "无法读取宿主 UUID");
const identity = {
  kind: "issue14-diagnostic-only",
  version,
  platform: target,
  sourceCommit: commit,
  actionsRun: process.env.GITHUB_RUN_ID ?? null,
  base: { tag: `v${version}`, name: baseName, url: baseURL, sha256: baseHash },
  host: { sha256: hostHash, uuid: hostUUID },
  component: {
    fingerprint: spec.fingerprint,
    archive: path.basename(archive),
    sha256: archiveHash,
  },
};
await writeFile(
  path.join(app, "Contents/Resources/issue14-test.json"),
  JSON.stringify(identity, null, 2) + "\n",
);
await installationReceipt(app, version, "app", "Contents/Resources/update-installation.json");
await run("codesign", ["--force", "--sign", "-", app]);
await run("codesign", ["--verify", "--deep", "--strict", app]);
const files = await inventory(app);
const allowedChanges = new Set([
  hostRelative,
  "Contents/MacOS/JAVM",
  "Contents/Info.plist",
  "Contents/_CodeSignature/CodeResources",
  "Contents/Resources/update-installation.json",
]);
for (const original of originalFiles) {
  if (allowedChanges.has(original.path)) continue;
  assert.equal(
    files.find((file) => file.path === original.path)?.sha256,
    original.sha256,
    `基础内容意外变化: ${original.path}`,
  );
}

const output = path.join(root, "dist/issue14-test");
await mkdir(output, { recursive: true });
const name = `JAVM-${version}-issue14-test-${commit.slice(0, 8)}-${target}`;
const zip = path.join(output, `${name}.zip`);
await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
const image = path.join(stage, "image");
await mkdir(image);
await run("ditto", [app, path.join(image, appName)]);
await symlink("/Applications", path.join(image, "Applications"));
const dmg = path.join(output, `${name}.dmg`);
await run("hdiutil", [
  "create",
  "-volname",
  "JAVM Issue14 Test",
  "-srcfolder",
  image,
  "-format",
  "UDZO",
  dmg,
]);

async function verifyPackagedApp(directory) {
  await run("codesign", ["--verify", "--deep", "--strict", directory]);
  assert.equal(sha256(await readFile(path.join(directory, hostRelative))), hostHash);
  assert.deepEqual(await inventory(directory), files);
  return verifyHostGlobals(path.join(directory, hostRelative));
}
const unzipped = path.join(stage, "zip-check");
await run("ditto", ["-x", "-k", zip, unzipped]);
const zipVerification = await verifyPackagedApp(path.join(unzipped, appName));
const mount = path.join(stage, "mount");
await mkdir(mount);
await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
let dmgVerification;
try {
  const installed = path.join(stage, "installed", appName);
  await run("ditto", [path.join(mount, appName), installed]);
  dmgVerification = await verifyPackagedApp(installed);
} finally {
  await run("hdiutil", ["detach", mount]);
}
const assets = await Promise.all(
  [zip, dmg].map(async (file) => ({
    name: path.basename(file),
    bytes: (await stat(file)).size,
    sha256: sha256(await readFile(file)),
  })),
);
await writeFile(
  path.join(output, "test-manifest.json"),
  JSON.stringify(
    {
      ...identity,
      componentManifest,
      files,
      assets,
      verification: { zip: zipVerification, dmg: dmgVerification },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(output, "SHA256SUMS"),
  assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n") + "\n",
);
await writeFile(
  path.join(output, "测试说明.txt"),
  `JAVM Intel macOS 闪退专项测试包（不是新版本发布）\n\n基于 1.0.17，仅替换修复后的宿主和测试包标识。\n源码提交：${commit}\n宿主 UUID：${hostUUID}\n\n1. 先完全退出原来的 JAVM。\n2. 打开 DMG，将“${appName}”拖到 Applications，再从这个新名称启动。\n3. 测试能否正常启动，以及移动、缩放窗口后是否仍闪退。\n4. 请反馈 macOS 版本和测试结果；若闪退，请附新的完整崩溃日志。\n\n测试版与正式版共用用户数据，本次安装不清空数据；请勿同时运行，也不要在测试期间执行应用内更新。\n应用内仍显示 1.0.17，可通过应用名称及本文件的 UUID 确认测试构建。\n本包仅作 ad-hoc 签名，未公证；如 macOS 拦截，请在系统“隐私与安全性”中允许本次打开。\n最低系统为 macOS 13；CI 在 macOS 15 Intel 上验证了隔离空白窗口及 Cocoa 协议查询，真实 Touch Bar 硬件仍需实机反馈。\n`,
);
console.log(
  JSON.stringify(
    { name, hostUUID, assets, verification: { zip: zipVerification, dmg: dmgVerification } },
    null,
    2,
  ),
);
