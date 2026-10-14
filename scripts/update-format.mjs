import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

export function releaseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|alpha)\.(0|[1-9]\d*))?$/.exec(
    value,
  );
  if (!match) throw new Error("发布版本必须为正式版本、beta.N 或 alpha.N");
  if ([match[1], match[2], match[3], match[5] ?? "0"].some((part) => part.length > 6))
    throw new Error("发布版本数字超过支持范围");
  return {
    channel: match[4] ?? "stable",
    major: +match[1],
    minor: +match[2],
    patch: +match[3],
    sequence: +(match[5] ?? 0),
  };
}
export function platformVersion(value, platform) {
  const version = releaseVersion(value);
  if (platform === "windows") {
    if (
      [version.major, version.minor, version.patch].some((part) => part > 65535) ||
      version.sequence > 32766
    )
      throw new Error("Windows 版本数字超出范围");
    return `${version.major}.${version.minor}.${version.patch}.${version.channel === "stable" ? 65535 : version.channel === "beta" ? 32768 + version.sequence : version.sequence}`;
  }
  if (platform === "deb") return value.replace(/-(alpha|beta)\./, "~$1.");
  if (version.channel !== "stable" && (version.sequence < 1 || version.sequence > 255))
    throw new Error("macOS 预发布序号必须在 1 到 255 之间");
  return `${version.major}.${version.minor}.${version.patch}${version.channel === "stable" ? "" : `${version.channel === "beta" ? "b" : "a"}${version.sequence}`}`;
}
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}
export function publicKeyHex(pem) {
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  if (jwk.crv !== "P-256") throw new Error("更新签名必须使用 P-256 密钥");
  return (
    "04" +
    Buffer.from(jwk.x, "base64url").toString("hex") +
    Buffer.from(jwk.y, "base64url").toString("hex")
  );
}
export function signManifest(manifest, pem) {
  const payload = JSON.stringify(manifest);
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("更新签名密钥类型无效");
  return {
    payload,
    signature: sign("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" }).toString(
      "hex",
    ),
  };
}
export function verifyManifest(envelope, publicPem) {
  return verify(
    "sha256",
    Buffer.from(envelope.payload),
    { key: publicPem, dsaEncoding: "ieee-p1363" },
    Buffer.from(envelope.signature, "hex"),
  );
}
export async function installationReceipt(
  directory,
  version,
  kind,
  receipt = "update-installation.json",
  extra = [],
) {
  const owned = [];
  async function visit(relative = "") {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const entry = relative ? relative + "/" + name : name;
      const info = await lstat(path.join(directory, entry));
      if (info.isSymbolicLink()) throw new Error("更新安装目录不允许链接: " + entry);
      if (info.isDirectory()) await visit(entry);
      else if (info.isFile()) owned.push(entry);
      else throw new Error("更新安装目录包含特殊文件");
    }
  }
  await visit();
  await writeFile(
    path.join(directory, receipt),
    JSON.stringify({
      schema: 1,
      app: "net.ddmoyu.javm",
      version,
      kind,
      owned: [...new Set([...owned, receipt, ...extra])].sort(),
    }) + "\n",
  );
}
export async function updateArchive(directory, destination) {
  const files = [];
  async function visit(relative = "") {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const entry = relative ? relative + "/" + name : name;
      if (
        /[^\x20-\x7e]|[\\:]/.test(entry) ||
        entry.split("/").some((p) => !p || p === "." || p === "..")
      )
        throw new Error("更新包路径无效: " + entry);
      const absolute = path.join(directory, entry),
        info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("更新包不允许符号链接: " + entry);
      if (info.isDirectory()) await visit(entry);
      else if (info.isFile())
        files.push({
          path: entry,
          bytes: info.size,
          sha256: await hashFile(absolute),
          executable: !!(info.mode & 0o111),
        });
      else throw new Error("更新包包含特殊文件");
    }
  }
  await visit();
  if (!files.length || files.length > 10000) throw new Error("更新包文件数量无效");
  const header = Buffer.from(JSON.stringify({ schema: 1, files }));
  if (header.length > 4 * 1024 * 1024) throw new Error("更新包清单过大");
  await mkdir(path.dirname(destination), { recursive: true });
  const stream = createWriteStream(destination, { flags: "wx" });
  const failure = once(stream, "error").then(([error]) => {
    throw error;
  });
  void failure.catch(() => {});
  const write = async (data) => {
    if (!stream.write(data)) await Promise.race([once(stream, "drain"), failure]);
  };
  try {
    const prefix = Buffer.alloc(12);
    prefix.write("JAVMUP1\n");
    prefix.writeUInt32LE(header.length, 8);
    await write(prefix);
    await write(header);
    for (const file of files)
      for await (const data of createReadStream(path.join(directory, file.path))) await write(data);
    stream.end();
    await Promise.race([once(stream, "finish"), failure]);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return files;
}
