import assert from "node:assert/strict";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  components,
  download,
  inventory,
  json,
  root,
  run,
  sha256,
  specification,
  target,
  targets,
  verifyInventory,
} from "./third-party/posix/common.mjs";
import { desktopHostFile } from "./desktop-host.mjs";
import { binaryArchitecture } from "./third-party/posix/verify.mjs";

if (!targets.includes(target)) throw new Error("此安装包需要在相应 POSIX 系统和架构上生成");
const pkg = await json(path.join(root, "package.json"));
const resolved = await json(path.join(root, `build/dependencies/${target}/resolved.json`));
for (const component of components) {
  const spec = await specification(component),
    dependency = resolved.components[component];
  assert.equal(dependency?.fingerprint, spec.fingerprint, "组件配方已变化，请重新准备依赖");
  assert.equal(dependency.tag, spec.tag);
  assert.ok(dependency.releaseId && dependency.archive.sha256, "只允许打包已发布并回读校验的组件");
  await verifyInventory(dependency.path, await json(path.join(dependency.path, "manifest.json")));
}
const desktop = path.join(root, "dist/desktop/javm");
const build = path.join(root, "build");
await mkdir(build, { recursive: true });
const stage = await mkdtemp(path.join(build, `posix-package-${target}-`));
const release = path.join(root, "dist/posix-release", target);
await mkdir(release, { recursive: true });
const name = `JAVM-${pkg.version}-${target}`;
const mac = process.platform === "darwin";
const application = mac ? path.join(stage, "JAVM.app") : path.join(stage, "JAVM");
const payload = mac ? path.join(application, "Contents/MacOS") : application;
await mkdir(payload, { recursive: true });
await copyFile(
  path.join(desktop, desktopHostFile().replace("neutralino", "javm")),
  path.join(payload, "JAVM-host"),
);
await copyFile(path.join(root, "bin/javm_launcher"), path.join(payload, "JAVM"));
await cp(path.join(desktop, "bin"), path.join(payload, "bin"), { recursive: true });
await copyFile(path.join(root, "resources/icon.png"), path.join(payload, "icon.png"));
await copyFile(path.join(root, "LICENSE"), path.join(payload, "LICENSE"));
// 只校验并更改自己生成的包；真实数据始终位于用户的系统数据目录。
const executables = [
  "JAVM",
  "JAVM-host",
  "bin/javm_database",
  "bin/javm_process",
  "bin/tools/curl",
  "bin/tools/ffmpeg",
  "bin/tools/metatube/metatube-server",
];
for (const relative of executables) {
  const file = path.join(payload, relative);
  assert.equal(binaryArchitecture(await readFile(file)), target, `错误的二进制架构: ${relative}`);
  await chmod(file, 0o755);
}
const library = mac ? "libmediainfo.0.dylib" : "libmediainfo.so.0";
const nativeBuild = path.join(root, "build/native", mac ? "macos-release" : "linux-release", "bin");
for (const binary of ["javm_database", "javm_process", library])
  assert.equal(
    sha256(await readFile(path.join(payload, "bin", binary))),
    sha256(await readFile(path.join(nativeBuild, binary))),
    "原生发布构建不匹配",
  );
await writeFile(
  path.join(release, "INSTALL.txt"),
  mac
    ? "JAVM 开发版（macOS 13 或更新系统）\n将 JAVM.app 拖入 Applications。开发包未使用 Developer ID 签名或公证。\n卸载时移除 APP；用户数据和系统钥匙串保持不变。\n"
    : "JAVM 开发版（Ubuntu 24.04 x64）\n推荐安装 DEB 以自动满足 GTK、WebKitGTK、Secret Service 和 ICU 运行依赖。\n便携包和 AppImage 需要相同系统依赖；AppImage 支持 --appimage-extract-and-run。\n用户数据保存在 XDG 数据目录，卸载程序不会删除片库。\n",
);
const assets = [];
async function asset(file, kind) {
  assets.push({
    name: path.basename(file),
    kind,
    bytes: (await stat(file)).size,
    sha256: sha256(await readFile(file)),
  });
}
if (mac) {
  const resources = path.join(application, "Contents/Resources");
  await mkdir(resources, { recursive: true });
  const iconset = path.join(stage, "JAVM.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      await run(
        "sips",
        [
          "-z",
          String(size * scale),
          String(size * scale),
          path.join(root, "resources/icon.png"),
          "--out",
          path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        ],
        root,
        true,
      );
  await run("iconutil", ["-c", "icns", "-o", path.join(resources, "JAVM.icns"), iconset]);
  await writeFile(
    path.join(application, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>net.ddmoyu.javm</string><key>CFBundleName</key><string>JAVM</string>
<key>CFBundleDisplayName</key><string>JAVM</string><key>CFBundleExecutable</key><string>JAVM</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconFile</key><string>JAVM.icns</string>
<key>CFBundleShortVersionString</key><string>${pkg.version.split("-")[0]}</string><key>CFBundleVersion</key><string>${pkg.version.split(".").at(-1)}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>\n`,
  );
  for (const relative of [...executables, `bin/${library}`]) {
    const file = path.join(payload, relative);
    const links = await run("otool", ["-L", file], root, true);
    assert.ok(
      !/\/opt\/homebrew|\/usr\/local\/|\/Users\/runner\//.test(
        links.split("\n").slice(1).join("\n"),
      ),
      `包内文件依赖构建机: ${relative}`,
    );
    await run("codesign", ["--force", "--sign", "-", file]);
  }
  // Apple Silicon 运行所需的 ad-hoc 校验，不使用开发者证书，不执行公证。
  await run("codesign", ["--force", "--deep", "--sign", "-", application]);
  await run("codesign", ["--verify", "--deep", "--strict", application]);
  const zip = path.join(release, `${name}-portable.zip`);
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", application, zip]);
  await asset(zip, "portable");
  const imageRoot = path.join(stage, "image");
  await mkdir(imageRoot);
  await cp(application, path.join(imageRoot, "JAVM.app"), { recursive: true });
  await symlink("/Applications", path.join(imageRoot, "Applications"));
  const dmg = path.join(release, `${name}.dmg`);
  await run("hdiutil", [
    "create",
    "-volname",
    "JAVM",
    "-srcfolder",
    imageRoot,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
  await asset(dmg, "installer");
} else {
  // 固定 Ubuntu 24.04 ABI；系统 WebKitGTK、GTK 和密钥环由发行版维护，DEB 明确声明。
  for (const relative of executables) {
    const file = path.join(payload, relative);
    const headers = await run("readelf", ["-l", file], root, true);
    if (!headers.includes("INTERP")) continue;
    const links = await run("ldd", [file], root, true);
    assert.ok(!links.includes("not found"), `缺少运行依赖: ${relative}`);
  }
  const tar = path.join(release, `${name}-portable.tar.gz`);
  await run("tar", ["-czf", tar, "-C", stage, "JAVM"]);
  await asset(tar, "portable");
  const deb = path.join(stage, "deb");
  await mkdir(path.join(deb, "DEBIAN"), { recursive: true });
  await cp(application, path.join(deb, "opt/JAVM"), { recursive: true });
  await mkdir(path.join(deb, "usr/bin"), { recursive: true });
  await writeFile(path.join(deb, "usr/bin/javm"), '#!/bin/sh\nexec /opt/JAVM/JAVM "$@"\n', {
    mode: 0o755,
  });
  const entry =
    "[Desktop Entry]\nType=Application\nName=JAVM\nComment=Local media library\nExec=/opt/JAVM/JAVM %u\nIcon=javm\nTerminal=false\nCategories=AudioVideo;Video;\nMimeType=x-scheme-handler/javm;\nStartupWMClass=JAVM\n";
  await mkdir(path.join(deb, "usr/share/applications"), { recursive: true });
  await writeFile(path.join(deb, "usr/share/applications/net.ddmoyu.javm.desktop"), entry);
  await mkdir(path.join(deb, "usr/share/icons/hicolor/256x256/apps"), { recursive: true });
  await copyFile(
    path.join(root, "resources/icon.png"),
    path.join(deb, "usr/share/icons/hicolor/256x256/apps/javm.png"),
  );
  await writeFile(
    path.join(deb, "DEBIAN/control"),
    `Package: javm\nVersion: ${pkg.version.replace("-alpha.", "~alpha.")}\nArchitecture: amd64\nMaintainer: JAVM <noreply@ddmoyu.net>\nSection: video\nPriority: optional\nDepends: libgtk-3-0t64, libwebkit2gtk-4.1-0, libsecret-1-0, libicu74, ca-certificates, libayatana-appindicator3-1\nRecommends: gnome-keyring\nHomepage: https://github.com/ddmoyu/javm\nDescription: JAVM local media library\n`,
  );
  await run("desktop-file-validate", [
    path.join(deb, "usr/share/applications/net.ddmoyu.javm.desktop"),
  ]);
  const debFile = path.join(release, `${name}.deb`);
  await run("dpkg-deb", ["--root-owner-group", "--build", deb, debFile]);
  await asset(debFile, "installer");
  const appDir = path.join(stage, "JAVM.AppDir");
  await cp(application, path.join(appDir, "usr/lib/javm"), { recursive: true });
  await writeFile(
    path.join(appDir, "AppRun"),
    '#!/bin/sh\nroot=$(CDPATH= cd -- "${0%/*}" && pwd)\nexec "$root/usr/lib/javm/JAVM" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(appDir, "javm.desktop"), entry.replace("/opt/JAVM/JAVM", "JAVM"));
  await copyFile(path.join(root, "resources/icon.png"), path.join(appDir, "javm.png"));
  const tools = await json(path.join(root, "scripts/third-party/posix/sources.json"));
  const appimagetool = await download(tools.appimagetool),
    runtime = await download(tools.appimageRuntime);
  await chmod(appimagetool, 0o755);
  const appImage = path.join(release, `${name}.AppImage`);
  await run(
    appimagetool,
    ["--appimage-extract-and-run", "--runtime-file", runtime, "--no-appstream", appDir, appImage],
    root,
    false,
    { ...process.env, ARCH: "x86_64" },
  );
  await chmod(appImage, 0o755);
  await asset(appImage, "installer");
}
const manifest = {
  schema: 1,
  version: pkg.version,
  platform: target,
  sourceCommit: await run("git", ["rev-parse", "HEAD"], root, true),
  minimumOS: mac ? "macOS 13.0" : "Ubuntu 24.04",
  signing: mac ? "ad-hoc; no Developer ID or notarization" : "unsigned",
  components: Object.fromEntries(
    Object.entries(resolved.components).map(([key, { path: _path, ...value }]) => [key, value]),
  ),
  files: await inventory(payload),
  assets,
};
await writeFile(
  path.join(release, `${name}-manifest.json`),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  path.join(release, "SHA256SUMS"),
  assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n") + "\n",
);
await writeFile(
  path.join(build, `posix-package-${target}.json`),
  JSON.stringify(
    { application, payload, release, manifest: path.join(release, `${name}-manifest.json`) },
    null,
    2,
  ),
);
console.log(`${target}: 已生成 ${assets.map((asset) => asset.name).join("、")}`);
