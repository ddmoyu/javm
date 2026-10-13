import { cp, copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  components,
  download,
  inventory,
  root,
  run,
  sha256,
  specification,
  target,
  targets,
} from "./common.mjs";
import { verifyRuntime } from "./verify.mjs";
import { patchNeutralino } from "./patch-neutralino.mjs";
import { desktopHostFile } from "../../desktop-host.mjs";

const suffix = process.platform === "darwin" ? "libmediainfo.0.dylib" : "libmediainfo.so.0";
const cmakeArgs = [
  "-G",
  "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  ...(process.platform === "darwin" ? ["-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"] : []),
];
async function unpack(source, parent) {
  const archive = await download(source);
  await mkdir(parent, { recursive: true });
  await run("tar", ["-xf", archive, "-C", parent]);
  const dirs = await readdir(parent, { withFileTypes: true });
  if (dirs.length !== 1 || !dirs[0].isDirectory()) throw new Error("源码归档结构无效");
  return path.join(parent, dirs[0].name);
}
async function copy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
}
async function configure(source, build, extra = []) {
  await run("cmake", ["-S", source, "-B", build, ...cmakeArgs, ...extra]);
  await run("cmake", ["--build", build, "--parallel", "4"]);
}
export async function buildComponent(component) {
  if (!targets.includes(target)) throw new Error("POSIX 组件需要在相应系统和架构上构建");
  const spec = await specification(component);
  const outputRoot = path.join(root, "build/components-posix", target);
  await mkdir(outputRoot, { recursive: true });
  const work = await mkdtemp(path.join(outputRoot, `${component}-`));
  const output = path.join(work, "package");
  await mkdir(path.join(output, "runtime"), { recursive: true });
  const source = spec.inputs.sources[component];
  if (component === "curl") {
    const openssl = await unpack(spec.inputs.sources.openssl, path.join(work, "openssl-source"));
    const ssl = path.join(output, "sdk/openssl");
    await run(
      "perl",
      [
        "Configure",
        process.platform === "darwin"
          ? process.arch === "arm64"
            ? "darwin64-arm64-cc"
            : "darwin64-x86_64-cc"
          : "linux-x86_64",
        "no-shared",
        "no-tests",
        "no-module",
        "no-legacy",
        "no-zlib",
        "--libdir=lib",
        `--prefix=${ssl}`,
        ...(process.platform === "darwin" ? ["-mmacosx-version-min=13.0"] : []),
      ],
      openssl,
    );
    await run("make", ["-j4"], openssl);
    await run("make", ["install_sw"], openssl);
    const curl = await unpack(source, path.join(work, "curl-source"));
    const build = path.join(work, "curl-build");
    await configure(path.join(root, "scripts/third-party/posix/curl"), build, [
      `-DJAVM_CURL_SOURCE=${curl}`,
      `-DOPENSSL_ROOT_DIR=${ssl}`,
      `-DCMAKE_INSTALL_PREFIX=${path.join(output, "sdk")}`,
    ]);
    await run("cmake", ["--install", build]);
    await copy(path.join(output, "sdk/bin/curl"), path.join(output, "runtime/curl"));
    await copy(path.join(curl, "COPYING"), path.join(output, "licenses/curl.txt"));
    await copy(path.join(openssl, "LICENSE.txt"), path.join(output, "licenses/OpenSSL.txt"));
  } else if (component === "mediainfo") {
    const build = path.join(work, "build");
    await configure(path.join(root, "scripts/third-party/posix/mediainfo"), build);
    await copy(path.join(build, "runtime", suffix), path.join(output, "runtime", suffix));
    const sourceRoot = path.join(build, "_deps/mediainfo_source-src");
    await copy(
      path.join(sourceRoot, "MediaInfoLib/Source/MediaInfoDLL"),
      path.join(output, "sdk/include/MediaInfoDLL"),
    );
    for (const [relative, name] of [
      ["MediaInfoLib/License.html", "MediaInfo.html"],
      ["ZenLib/License.txt", "ZenLib.txt"],
      ["zlib/LICENSE", "zlib.txt"],
    ])
      await copy(path.join(sourceRoot, relative), path.join(output, "licenses", name));
    if (process.platform === "darwin") {
      await run("install_name_tool", [
        "-id",
        `@rpath/${suffix}`,
        path.join(output, "runtime", suffix),
      ]);
      await run("codesign", ["--force", "--sign", "-", path.join(output, "runtime", suffix)]);
    }
  } else if (component === "ffmpeg") {
    const sourceRoot = await unpack(source, path.join(work, "source"));
    const reference = await download(spec.inputs.sources.ffmpegReference);
    const list = await run("unzip", ["-Z1", reference], work, true);
    const entry = list
      .split("\n")
      .find((name) => /(?:^|\/)build-info\/video-decoders\.txt$/.test(name));
    if (!entry) throw new Error("缺少锁定的视频解码器集合");
    const decoders = await run("unzip", ["-p", reference, entry], work, true);
    if (!/^[a-z0-9_\r\n]+$/.test(decoders)) throw new Error("视频解码器列表无效");
    const decoderFile = path.join(work, "video-decoders.txt");
    await writeFile(decoderFile, decoders + "\n");
    const build = path.join(work, "build");
    await run("bash", [
      path.join(root, "scripts/third-party/posix/ffmpeg.sh"),
      sourceRoot,
      build,
      decoderFile,
    ]);
    await copy(path.join(build, "ffmpeg"), path.join(output, "runtime/ffmpeg"));
    for (const name of ["COPYING.LGPLv2.1", "COPYING.LGPLv3", "LICENSE.md"])
      await copy(path.join(sourceRoot, name), path.join(output, "licenses", name));
    await copy(path.join(build, "ffbuild/config.mak"), path.join(output, "recipe/config.mak"));
    await copy(decoderFile, path.join(output, "recipe/video-decoders.txt"));
  } else if (component === "neutralino") {
    const sourceRoot = await unpack(source, path.join(work, "source"));
    await patchNeutralino(sourceRoot, source.commit);
    await configure(sourceRoot, path.join(work, "build"));
    await copy(
      path.join(sourceRoot, "bin", desktopHostFile()),
      path.join(output, "runtime/neutralino"),
    );
    await copy(path.join(sourceRoot, "LICENSE"), path.join(output, "licenses/Neutralino.txt"));
    await copy(
      path.join(root, "scripts/third-party/posix/patch-neutralino.mjs"),
      path.join(output, "recipe/patch-neutralino.mjs"),
    );
    await writeFile(
      path.join(output, "licenses/modifications.txt"),
      `Official Neutralino ${source.version}, source ${source.commit}.\nJAVM POSIX build: JSON-escape injected global strings and retain upstream source identity. Official APIs and Extension protocol are unchanged.\n`,
    );
  } else {
    await run(process.execPath, [
      "--use-env-proxy",
      path.join(root, "scripts/build-metatube-lite.mjs"),
    ]);
    const built = path.join(root, `build/metatube-lite-${target}`);
    for (const name of ["metatube-server", "installed.json"])
      await copy(path.join(built, name), path.join(output, "runtime", name));
    await copy(path.join(built, "licenses"), path.join(output, "licenses"));
    await copy(path.join(built, "build-info.txt"), path.join(output, "recipe/build-info.txt"));
  }
  await verifyRuntime(output, spec);
  const files = await inventory(output);
  const manifest = {
    ...spec,
    sourceCommit: await run("git", ["rev-parse", "HEAD"], root, true),
    verification: { passed: true, platform: target, performedAt: new Date().toISOString() },
    files,
  };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const archive = path.join(outputRoot, `${spec.tag}.tar.gz`);
  await run("tar", ["-czf", archive, "-C", output, "."]);
  const digest = sha256(await readFile(archive));
  await copyFile(path.join(output, "manifest.json"), path.join(outputRoot, `${spec.tag}.json`));
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  return { spec, output, archive, digest, manifest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv[2];
  if (!components.includes(requested))
    throw new Error("请指定 curl / mediainfo / ffmpeg / metatube");
  const result = await buildComponent(requested);
  console.log(JSON.stringify({ archive: result.archive, sha256: result.digest }));
}
