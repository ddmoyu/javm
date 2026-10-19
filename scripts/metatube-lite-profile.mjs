import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function metatubeRecipeHash() {
  const hash = createHash("sha256");
  for (const name of [
    "build-metatube-lite.mjs",
    "metatube-lite/source-lock.json",
    "metatube-lite/diagnostics.mjs",
    "metatube-lite/diagnostics/engine.go",
    "metatube-lite/diagnostics/route.go",
    "../tests/fixtures/metatube-diagnostics/engine_test.go",
    "../tests/fixtures/metatube-diagnostics/route_test.go",
  ]) {
    hash.update(name).update("\0");
    hash.update(
      (await readFile(path.join(root, "scripts", name), "utf8")).replaceAll("\r\n", "\n"),
    );
  }
  return hash.digest("hex");
}

export async function verifyMetatubeLite(directory, dependency) {
  const receipt = JSON.parse(await readFile(path.join(directory, "installed.json"), "utf8"));
  const binary = path.join(
    directory,
    process.platform === "win32" ? "metatube-server.exe" : "metatube-server",
  );
  const target = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;
  if (
    (receipt.platform !== undefined && receipt.platform !== target) ||
    receipt.version !== dependency.version ||
    receipt.profile !== dependency.profile ||
    receipt.sourceCommit !== dependency.sourceCommit ||
    receipt.sourceSha256 !== dependency.sha256 ||
    receipt.toolchain !== dependency.toolchain ||
    receipt.recipeSha256 !== (await metatubeRecipeHash()) ||
    receipt.bytes !== (await stat(binary)).size ||
    receipt.sha256 !== sha256(await readFile(binary))
  )
    throw new Error("MetaTube 精简产物缺失或过期，请重新运行 pnpm metatube:build --install。");
  return receipt;
}
