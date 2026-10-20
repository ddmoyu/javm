import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, platforms, specification, inventory, verifyPayload, sha256 } from "./components.mjs";
import { verifyRuntime } from "./verify.mjs";

export async function pack(component) {
  const outputRoot = path.join(root, "build/third-party-artifacts");
  const spec = await specification(component);
  const platform = process.env.JAVM_COMPONENT_PLATFORM || "windows-x64";
  if (!platforms.includes(platform)) throw new Error("未实现的组件平台：" + platform);
  await mkdir(path.join(root, "build/third-party-stage"), { recursive: true });
  const stage = await mkdtemp(path.join(root, "build/third-party-stage/" + component + "-"));
  const copy = async (source, relative) => {
    const target = path.join(stage, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, source), target, { recursive: true });
  };
  if (component === "ffmpeg") {
    for (const name of ["ffmpeg.exe", "ffmpeg-lite.json"])
      await copy("bin/tools/" + name, "runtime/" + name);
    await copy("bin/licenses/ffmpeg-lite", "licenses");
  } else if (component === "metatube") {
    for (const name of ["metatube-server.exe", "installed.json"])
      await copy("build/metatube-lite/" + name, "runtime/" + name);
    await copy("build/metatube-lite/licenses", "licenses");
    for (const name of ["build-info.txt", "verification.json"])
      await copy("build/metatube-lite/" + name, "build/" + name);
  } else if (component === "mediainfo") {
    for (const name of ["runtime", "sdk", "licenses"])
      await copy("build/third-party-build/mediainfo/install/" + name, name);
  } else if (component === "curl") {
    await copy("bin/tools/curl.exe", "runtime/curl.exe");
    for (const name of ["include", "lib"])
      await copy("build/curl-unicode/install/" + name, "sdk/" + name);
    await copy("bin/licenses/curl.txt", "licenses/curl.txt");
  }
  const manifest = {
    schema: 1,
    ...spec,
    platform,
    commit:
      process.env.GITHUB_SHA ||
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    workflowRun: process.env.GITHUB_RUN_ID || null,
    files: await inventory(stage),
  };
  await verifyPayload(stage, manifest, spec, platform);
  await verifyRuntime(stage, manifest);
  await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const output = path.join(outputRoot, component);
  await mkdir(output, { recursive: true });
  const archive = path.join(output, component + "-" + platform + ".zip");
  await rm(archive, { force: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:JAVM_COMPONENT_STAGE,$env:JAVM_COMPONENT_ARCHIVE,[IO.Compression.CompressionLevel]::Optimal,$false)",
    ],
    {
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, JAVM_COMPONENT_STAGE: stage, JAVM_COMPONENT_ARCHIVE: archive },
    },
  );
  const record = {
    ...manifest,
    archive: {
      name: path.basename(archive),
      bytes: (await stat(archive)).size,
      sha256: sha256(await readFile(archive)),
    },
  };
  await writeFile(
    path.join(output, "manifest-" + platform + ".json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify({ tag: spec.tag, archive, bytes: record.archive.bytes }));
}
