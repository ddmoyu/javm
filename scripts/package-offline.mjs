import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyFfmpegLite } from "./verify-ffmpeg-lite.mjs";
import { verifyMediaInfoLite } from "./verify-mediainfo-lite.mjs";
import { verifyMetatubeLite } from "./metatube-lite-profile.mjs";
import { components, specification, readJson } from "./third-party/components.mjs";

if (process.platform !== "win32") throw new Error("Offline packaging requires Windows x64.");
const archiveEnabled = !process.argv.includes("--no-archive");
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const dependencies = JSON.parse(
  await readFile(path.join(root, "scripts/offline-dependencies.json"), "utf8"),
);
const desktop = path.join(root, "dist/desktop/javm");
const ffmpegReceipt = await verifyFfmpegLite(path.join(desktop, "bin/tools"), dependencies.ffmpeg);
const mediaInfoReceipt = await verifyMediaInfoLite(
  path.join(desktop, "bin"),
  dependencies.mediainfo,
);
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
const metatubeReceipt = await verifyMetatubeLite(metatubeDirectory, dependencies.metatube);
const componentReleases = await readJson(path.join(root, "build/dependencies/resolved.json"));
for (const component of components) {
  const expected = await specification(component);
  const resolved = componentReleases.components[component];
  if (resolved?.fingerprint !== expected.fingerprint || resolved.tag !== expected.tag)
    throw new Error("Package component does not match its published recipe: " + component);
}
// Refuse a package assembled from the development Debug binary.
for (const [binary, candidate] of [
  ["javm_database.exe", path.join(desktop, "bin/javm_database.exe")],
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
// Notices, build receipts and file hashes stay in the developer-side manifest.
const licenseDocuments = new Map();
const buildDocuments = new Map();
const collectDocument = async (documents, source, label) => {
  const content = await readFile(source, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  const entry = documents.get(digest) ?? { content, labels: new Set() };
  entry.labels.add(label);
  documents.set(digest, entry);
};
const serializeDocuments = (documents) =>
  [...documents.entries()].map(([sha256, entry]) => ({
    components: [...entry.labels].sort((a, b) => a.localeCompare(b)),
    sha256,
    text: entry.content,
  }));
// The official embedded host resolves its own application directory. A separate
// launcher is unnecessary; expose the host itself as the only root executable.
await copy(path.join(desktop, "javm-win_x64.exe"), "JAVM.exe");
for (const file of ["javm_database.exe", "MediaInfo.dll"]) {
  await copy(path.join(desktop, "bin", file), `bin/${file}`);
}
for (const file of ["MediaInfo.html", "ZenLib.txt", "zlib.txt", "pugixml.txt", "curl.txt"]) {
  await collectDocument(licenseDocuments, path.join(root, "bin/licenses", file), file);
}
for (const file of ["COPYING.LGPLv2.1", "COPYING.LGPLv3", "LICENSE.md"])
  await collectDocument(
    licenseDocuments,
    path.join(root, "bin/licenses/ffmpeg-lite", file),
    `FFmpeg / ${file}`,
  );
for (const file of [
  "build-ffmpeg-lite.ps1",
  "build-ffmpeg-lite.sh",
  "config.mak",
  "ffmpeg.exe-version.txt",
  "reference-video-decoders.txt",
])
  await collectDocument(
    buildDocuments,
    path.join(root, "bin/licenses/ffmpeg-lite", file),
    `FFmpeg / ${file}`,
  );
for (const file of ["CMakeLists.txt", "write-receipt.cmake"])
  await collectDocument(
    buildDocuments,
    path.join(root, "native/media/mediainfo", file),
    `MediaInfo / ${file}`,
  );
for (const file of [
  "ffmpeg.exe",
  "curl.exe",
  "metatube/metatube-server.exe",
  "metatube/installed.json",
]) {
  await copy(path.join(desktop, "bin/tools", file), `bin/tools/${file}`);
}
// 窗口和托盘读取 EXE 内嵌图标，不再分发重复的 resources/icon.png。
for (const file of ["MetaTube.txt", "Neutralino.txt", "phosphor-icons-react.txt"])
  await collectDocument(licenseDocuments, path.join(root, "resources/licenses", file), file);
for (const file of ["MetaTube.txt", "gorm-datatypes.txt", "useragent.txt", "modifications.txt"])
  await collectDocument(
    licenseDocuments,
    path.join(root, "bin/licenses/metatube-lite", file),
    `MetaTube lite / ${file}`,
  );
for (const file of ["build-metatube-lite.mjs", "metatube-lite/source-lock.json"])
  await collectDocument(
    buildDocuments,
    path.join(root, "scripts", file),
    `MetaTube lite / ${file}`,
  );
await collectDocument(
  buildDocuments,
  path.join(root, "scripts/build-curl.ps1"),
  "curl / build-curl.ps1",
);
await collectDocument(licenseDocuments, path.join(root, "LICENSE"), "JAVM / LICENSE");
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
        await collectDocument(
          licenseDocuments,
          path.join(base, file),
          `${entry.name}@${entry.version} / ${file}`,
        );
      }
    }
  }
}
await collectDocument(
  licenseDocuments,
  path.join(root, "build/native/windows-release/_deps/nlohmann_json-src/LICENSE.MIT"),
  "nlohmann-json / LICENSE.MIT",
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
  layout: "runtime-only",
  entryPoint: "JAVM.exe",
  builtAt: new Date().toISOString(),
  source: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  },
  dependencies,
  componentReleases,
  buildReceipts: { ffmpeg: ffmpegReceipt, mediainfo: mediaInfoReceipt, metatube: metatubeReceipt },
  frontendDependencies: notices,
  licenseNotices: serializeDocuments(licenseDocuments),
  buildInformation: serializeDocuments(buildDocuments),
  systemRequirements: { webview2: "Installed Evergreen WebView2 Runtime; not bundled" },
  files,
};
const manifestPath = path.join(root, "build/offline-manifests", `${name}.json`);
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const archive = archiveEnabled ? `${output}.zip` : null;
let sha256 = null;
if (archive) {
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
  sha256 = await hash(archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
}
await writeFile(
  path.join(root, "dist/offline/latest.json"),
  JSON.stringify(
    {
      directory: output,
      archive,
      sha256,
      bytes: archive
        ? (await stat(archive)).size
        : files.reduce((total, file) => total + file.bytes, 0),
      files: files.length,
      entryPoint: "JAVM.exe",
      manifest: manifestPath,
      manifestSha256: await hash(manifestPath),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ directory: output, archive, sha256, files: files.length }, null, 2));
