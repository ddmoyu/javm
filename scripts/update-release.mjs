import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicKeyHex, releaseVersion, signManifest, hashFile } from "./update-format.mjs";

export function updateManifest(version, files) {
  const { channel } = releaseVersion(version);
  if (channel === "alpha") throw new Error("Alpha 不发布自动更新清单");
  const planned = [
    ["windows-x64", "portable", "-update.jup"],
    ["windows-x64", "setup", "-setup.exe"],
    ["macos-x64", "app", "-update.jup"],
    ["macos-arm64", "app", "-update.jup"],
    ["linux-x64", "portable", "-update.jup"],
    ["linux-x64", "appimage", ".AppImage"],
    ["linux-x64", "deb", ".deb"],
  ];
  const assets = planned.map(([platform, kind, suffix]) => {
    const name = `JAVM-${version}-${platform}${suffix}`;
    const found = files.filter((file) => file.name === name);
    if (
      found.length !== 1 ||
      !Number.isSafeInteger(found[0].bytes) ||
      found[0].bytes <= 0 ||
      found[0].bytes > 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(found[0].sha256)
    )
      throw new Error("缺少可信更新附件：" + name);
    return { platform, kind, ...found[0] };
  });
  return { schema: 1, app: "net.ddmoyu.javm", minimumUpdater: 1, version, channel, assets };
}
export async function writeUpdateManifest(directory, version, files, publicKeyFile, privateKey) {
  if (!privateKey) throw new Error("正式版和 Beta 发布必须配置 JAVM_UPDATE_PRIVATE_KEY secret");
  const expected = JSON.parse(await readFile(publicKeyFile, "utf8"));
  if (publicKeyHex(privateKey) !== expected.publicKeyHex)
    throw new Error("签名私钥与编译进程序的更新公钥不匹配");
  const manifest = updateManifest(version, files);
  for (const asset of manifest.assets)
    if ((await hashFile(path.join(directory, asset.name))) !== asset.sha256)
      throw new Error("签名前更新附件发生变化");
  const file = path.join(directory, "JAVM-update.json");
  const data = JSON.stringify(signManifest(manifest, privateKey)) + "\n";
  await writeFile(file, data);
  return { name: "JAVM-update.json", bytes: Buffer.byteLength(data), sha256: await hashFile(file) };
}
