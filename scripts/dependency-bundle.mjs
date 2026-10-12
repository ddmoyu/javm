import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyFfmpegLite } from "./verify-ffmpeg-lite.mjs";
import { verifyMediaInfoLite } from "./verify-mediainfo-lite.mjs";

export const recipeFiles = [
  "scripts/offline-dependencies.json",
  "scripts/build-ffmpeg-lite.ps1",
  "scripts/build-ffmpeg-lite.sh",
  "scripts/build-curl.ps1",
  "scripts/setup-offline-tools.ps1",
  "scripts/build-dependencies.ps1",
  "scripts/dependency-project/CMakeLists.txt",
  "scripts/package-dependencies.mjs",
  "scripts/dependency-bundle.mjs",
  "scripts/verify-ffmpeg-lite.mjs",
  "scripts/verify-mediainfo-lite.mjs",
  "native/media/mediainfo/CMakeLists.txt",
  "native/media/mediainfo/write-receipt.cmake",
];
export async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export function safeChild(root, name) {
  if (!name || name.includes("\\") || name.includes(":") || name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Unsafe bundle path");
  return path.join(root, ...name.split("/"));
}
export async function recipeHash(root) {
  const digest = createHash("sha256");
  for (const file of recipeFiles)
    digest.update(file + "\0").update((await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n"));
  return digest.digest("hex");
}
export async function inventory(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    const file = safeChild(root, name);
    if (entry.isDirectory()) files.push(...await inventory(root, name));
    else if (entry.isFile()) files.push({ path: name, bytes: (await lstat(file)).size, sha256: await hashFile(file) });
    else throw new Error("Links are not permitted in dependency bundles");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export async function verifyBundle(root, project) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const expected = JSON.parse(await readFile(path.join(project, "scripts/offline-dependencies.json"), "utf8"));
  if (manifest.schema !== 1 || manifest.platform !== "windows-x64" ||
      manifest.recipeSha256 !== await recipeHash(project) || !isDeepStrictEqual(manifest.dependencies, expected))
    throw new Error("Dependency bundle does not match the locked build recipe");
  for (const entry of manifest.files) safeChild(root, entry.path);
  const actual = (await inventory(root)).filter((file) => file.path !== "manifest.json");
  if (!isDeepStrictEqual(actual, manifest.files)) throw new Error("Dependency bundle inventory/hash mismatch");
  await verifyFfmpegLite(path.join(root, "bin/tools"), expected.ffmpeg);
  await verifyMediaInfoLite(path.join(root, "bin"), expected.mediainfo);
  return manifest;
}
