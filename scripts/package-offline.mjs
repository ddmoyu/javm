import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyFfmpegLite } from "./verify-ffmpeg-lite.mjs";
import { verifyMediaInfoLite } from "./verify-mediainfo-lite.mjs";

if (process.platform !== "win32") throw new Error("Offline packaging requires Windows x64.");
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const dependencies = JSON.parse(
  await readFile(path.join(root, "scripts/offline-dependencies.json"), "utf8"),
);
const desktop = path.join(root, "dist/desktop/javm");
await verifyFfmpegLite(path.join(desktop, "bin/tools"), dependencies.ffmpeg);
await verifyMediaInfoLite(path.join(desktop, "bin"), dependencies.mediainfo);
const curlVersion = execFileSync(path.join(desktop, "bin/tools/curl.exe"), ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (!curlVersion.includes("Unicode") || !curlVersion.includes("Schannel"))
  throw new Error(
    "Offline curl must support Unicode paths and Windows Schannel. Run pnpm offline:setup and pnpm desktop:build.",
  );
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");
const name = `JAVM-${pkg.version}-windows-x64-offline-${stamp}`;
const output = path.join(root, "dist/offline", name);
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};
// MetaTube is a required package component, never a first-run download.
const metatubeDirectory = path.join(desktop, "bin/tools/metatube");
const metatube = JSON.parse(await readFile(path.join(metatubeDirectory, "installed.json"), "utf8"));
const metatubeBinary = path.join(metatubeDirectory, "metatube-server.exe");
if (
  metatube.version !== dependencies.metatube.version ||
  metatube.sourceSha256 !== dependencies.metatube.sha256 ||
  metatube.bytes !== (await stat(metatubeBinary)).size ||
  metatube.sha256 !== (await hash(metatubeBinary))
)
  throw new Error(
    "Bundled MetaTube is missing or stale. Run pnpm offline:setup and pnpm desktop:build.",
  );
// Refuse a package assembled from the development Debug binary.
for (const [binary, candidate] of [
  ["javm_database.exe", path.join(desktop, "bin/javm_database.exe")],
  ["JAVM.exe", path.join(root, "bin/JAVM.exe")],
  ["MediaInfo.dll", path.join(desktop, "bin/MediaInfo.dll")],
]) {
  if (
    (await hash(candidate)) !==
    (await hash(path.join(root, "build/native/windows-release/bin", binary)))
  )
    throw new Error(`Release build mismatch: ${binary}. Run pnpm desktop:build first.`);
}
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Never merge into a package that may already contain user data.
const copy = async (source, target) => {
  await mkdir(path.dirname(path.join(output, target)), { recursive: true });
  await cp(source, path.join(output, target), { recursive: true });
};
await copy(path.join(desktop, "javm-win_x64.exe"), "javm-win_x64.exe");
await copy(path.join(root, "bin/JAVM.exe"), "JAVM.exe");
for (const file of ["javm_database.exe", "MediaInfo.dll", "mediainfo-lite.json"]) {
  await copy(path.join(desktop, "bin", file), `bin/${file}`);
}
for (const file of [
  "MediaInfo.html",
  "ZenLib.txt",
  "zlib.txt",
  "pugixml.txt",
  "N_m3u8DL-RE.txt",
  "curl.txt",
]) {
  await copy(path.join(root, "bin/licenses", file), `bin/licenses/${file}`);
}
await copy(path.join(root, "bin/licenses/ffmpeg-lite"), "bin/licenses/ffmpeg-lite");
await copy(path.join(root, "native/media/mediainfo"), "bin/licenses/mediainfo-lite");
for (const file of [
  "ffmpeg.exe",
  "ffmpeg-lite.json",
  "curl.exe",
  "N_m3u8DL-RE.exe",
  "metatube/metatube-server.exe",
  "metatube/installed.json",
]) {
  await copy(path.join(desktop, "bin/tools", file), `bin/tools/${file}`);
}
await copy(path.join(root, "resources/icon.png"), "resources/icon.png");
await copy(path.join(root, "resources/licenses"), "bin/licenses");
await copy(path.join(root, "scripts/build-curl.ps1"), "bin/licenses/curl-build.ps1");
await copy(path.join(root, "LICENSE"), "LICENSE");
await copy(path.join(root, "resources/offline/使用说明.txt"), "使用说明.txt");
await copy(path.join(root, "resources/offline/Verify-Package.ps1"), "Verify-Package.ps1");
for (const file of ["Install-JAVM.ps1", "Uninstall-JAVM.ps1"])
  await copy(path.join(root, "resources/offline", file), file);
await copy(path.join(root, "resources/offline/Package-Tools.ps1"), "installer/Package-Tools.ps1");
// Preserve the original license text for production frontend dependencies.
const licenses = JSON.parse(
  execFileSync(process.env.ComSpec, ["/d", "/s", "/c", "pnpm licenses list --prod --json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }),
);
const notices = [];
for (const packages of Object.values(licenses)) {
  for (const entry of packages) {
    const { paths, ...notice } = entry;
    notices.push(notice);
    const base = paths[0];
    for (const file of await readdir(base)) {
      if (
        /^(license|licence|copying|notice)(\.|$)/i.test(file) &&
        (await stat(path.join(base, file))).isFile()
      ) {
        await copy(
          path.join(base, file),
          `bin/licenses/frontend/${entry.name.replaceAll("/", "_")}/${file}`,
        );
      }
    }
  }
}
await writeFile(
  path.join(output, "bin/licenses/frontend/dependencies.json"),
  JSON.stringify(notices, null, 2),
);
await copy(
  path.join(root, "build/native/windows-release/_deps/nlohmann_json-src/LICENSE.MIT"),
  "bin/licenses/nlohmann-json.txt",
);
const files = [];
async function inventory(relative = "") {
  for (const entry of await readdir(path.join(output, relative), { withFileTypes: true })) {
    const item = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await inventory(item);
    else if (entry.isFile()) {
      const absolute = path.join(output, item);
      files.push({ path: item, bytes: (await stat(absolute)).size, sha256: await hash(absolute) });
    } else throw new Error(`Unexpected package entry: ${item}`);
  }
}
if (process.env.JAVM_SIGN_CERT_THUMBPRINT)
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts/sign-package.ps1"),
      "-PackageDirectory",
      output,
    ],
    { stdio: "inherit", windowsHide: true },
  );
await inventory();
const manifest = {
  app: "JAVM",
  version: pkg.version,
  platform: "windows-x64",
  builtAt: new Date().toISOString(),
  dependencies,
  systemRequirements: { webview2: "Installed Evergreen WebView2 Runtime; not bundled" },
  files,
};
await writeFile(path.join(output, "package-manifest.json"), JSON.stringify(manifest, null, 2));
const archive = `${output}.zip`;
await new Promise((resolve, reject) => {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts/archive-offline.ps1"),
      "-Source",
      output,
      "-Destination",
      archive,
    ],
    { windowsHide: true, stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`ZIP creation failed: ${code}`)),
  );
});
const sha256 = await hash(archive);
await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
await writeFile(
  path.join(root, "dist/offline/latest.json"),
  JSON.stringify(
    { directory: output, archive, sha256, bytes: (await stat(archive)).size, files: files.length },
    null,
    2,
  ),
);
console.log(JSON.stringify({ directory: output, archive, sha256, files: files.length }, null, 2));
