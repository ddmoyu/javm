import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

export async function verifyMediaInfoLite(directory, expected, buildReceipt) {
  const receipt =
    buildReceipt ?? JSON.parse(await readFile(path.join(directory, "mediainfo-lite.json"), "utf8"));
  if (!isDeepStrictEqual(receipt.source, expected) || receipt.buildType !== "Release")
    throw new Error("MediaInfo source/profile/Release mismatch. Run pnpm desktop:build.");
  const binary = path.join(directory, "MediaInfo.dll");
  const bytes = (await stat(binary)).size;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(binary)) digest.update(chunk);
  if (
    receipt.binary.name !== "MediaInfo.dll" ||
    receipt.binary.bytes !== bytes ||
    receipt.binary.sha256 !== digest.digest("hex")
  )
    throw new Error("MediaInfo DLL does not match its build receipt.");
  return receipt;
}
