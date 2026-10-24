import { createHash, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRelease } from "./third-party/github.mjs";
import { releaseVersion, verifyManifest } from "./update-format.mjs";
import { updateManifest } from "./update-release.mjs";

export const betaChannelTag = "updates-beta";
const manifestName = "JAVM-update.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function compareUpdateVersions(a, b) {
  const left = releaseVersion(a),
    right = releaseVersion(b);
  for (const field of ["major", "minor", "patch"])
    if (left[field] !== right[field]) return left[field] - right[field];
  const rank = { alpha: 0, beta: 1, stable: 2 };
  return rank[left.channel] - rank[right.channel] || left.sequence - right.sequence;
}

export function newestUpdateRelease(releases) {
  return releases
    .filter((release) => {
      if (release.draft || !release.tag_name?.startsWith("v")) return false;
      try {
        const { channel } = releaseVersion(release.tag_name.slice(1));
        return (
          channel !== "alpha" &&
          release.prerelease === (channel === "beta") &&
          release.assets?.some((asset) => asset.name === manifestName && asset.state === "uploaded")
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => compareUpdateVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
}

export function verifyChannelManifest(data, publicKeyHex, expectedVersion) {
  if (Buffer.byteLength(data) > 65536 || !/^04[a-f0-9]{128}$/.test(publicKeyHex))
    throw new Error("通道清单或更新公钥无效");
  const envelope = JSON.parse(data);
  if (typeof envelope.payload !== "string" || !/^[a-f0-9]{128}$/.test(envelope.signature || ""))
    throw new Error("通道清单签名格式无效");
  const point = Buffer.from(publicKeyHex, "hex");
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
  });
  if (!verifyManifest(envelope, key)) throw new Error("通道清单官方签名无效");
  const manifest = JSON.parse(envelope.payload);
  if (
    manifest.schema !== 1 ||
    manifest.app !== "net.ddmoyu.javm" ||
    manifest.minimumUpdater !== 1 ||
    (expectedVersion && manifest.version !== expectedVersion)
  )
    throw new Error("通道清单版本或应用不匹配");
  const expected = updateManifest(
    manifest.version,
    manifest.assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  );
  if (
    manifest.channel !== expected.channel ||
    manifest.assets.length !== expected.assets.length ||
    expected.assets.some(
      (asset) =>
        !manifest.assets.some(
          (entry) =>
            entry.name === asset.name &&
            entry.platform === asset.platform &&
            entry.kind === asset.kind,
        ),
    )
  )
    throw new Error("通道清单平台或通道不匹配");
  return manifest;
}

// 仅在发布端使用已认证的 GitHub API；客户端只下载固定地址的签名清单。
export async function publishBetaChannel({ gh, repository, commit, directory, publicKeyHex }) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const items = JSON.parse(
      gh([
        "api",
        `repos/${repository}/releases?per_page=100&page=${page}`,
        "--jq",
        "map({tag_name, draft, prerelease, assets: [.assets[] | {name, size, digest, state}]})",
      ]),
    );
    if (!Array.isArray(items)) throw new Error("无法读取已发布版本");
    releases.push(...items);
    if (items.length < 100) break;
    if (page === 20) throw new Error("发布记录超出通道同步上限");
  }
  const newest = newestUpdateRelease(releases);
  if (!newest) throw new Error("没有可用于 Beta 通道的已发布签名清单");
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(path.join(directory, "beta-channel-"));
  const download = async (tag, name) => {
    const target = path.join(stage, name);
    await mkdir(target);
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      manifestName,
      "--dir",
      target,
    ]);
    return readFile(path.join(target, manifestName));
  };
  const data = await download(newest.tag_name, "candidate");
  const manifest = verifyChannelManifest(data, publicKeyHex, newest.tag_name.slice(1));
  const sourceAsset = newest.assets.find((asset) => asset.name === manifestName);
  if (sourceAsset.size !== data.length || sourceAsset.digest !== `sha256:${sha256(data)}`)
    throw new Error("已发布清单回读哈希不匹配");
  // 完整附件仍位于原始版本 Release，通道附件只复制签名清单。
  for (const asset of manifest.assets) {
    const published = newest.assets.find((entry) => entry.name === asset.name);
    if (
      !published ||
      published.state !== "uploaded" ||
      published.size !== asset.bytes ||
      published.digest !== `sha256:${asset.sha256}`
    )
      throw new Error("通道目标的发布附件不完整或哈希不符：" + asset.name);
  }
  let channel = findRelease(gh, repository, betaChannelTag);
  if (channel) {
    if (channel.immutable || !channel.prerelease)
      throw new Error("Beta 通道 Release 必须可变且标记为预发布");
    if (channel.assets.some((asset) => asset.name === manifestName)) {
      const previousData = await download(betaChannelTag, "previous");
      const previous = verifyChannelManifest(previousData, publicKeyHex);
      const comparison = compareUpdateVersions(previous.version, manifest.version);
      if (comparison > 0) throw new Error("拒绝将 Beta 通道指向较旧版本");
      if (comparison === 0 && sha256(previousData) !== sha256(data))
        throw new Error("同一版本的通道清单发生变化");
      if (comparison === 0 && !channel.draft) return manifest.version;
    }
  }
  const notes = path.join(stage, "notes.md");
  await writeFile(
    notes,
    "Beta 更新通道的静态签名清单，由发布流程维护。\n\n" +
      `当前版本：[${manifest.version}](https://github.com/${repository}/releases/tag/${newest.tag_name})。\n`,
  );
  if (!channel) {
    gh([
      "release",
      "create",
      betaChannelTag,
      "--repo",
      repository,
      "--target",
      commit,
      "--draft",
      "--prerelease",
      "--latest=false",
      "--title",
      "JAVM Beta 更新通道",
      "--notes-file",
      notes,
    ]);
  }
  gh([
    "release",
    "upload",
    betaChannelTag,
    path.join(stage, "candidate", manifestName),
    "--repo",
    repository,
    "--clobber",
  ]);
  const readback = await download(betaChannelTag, "readback");
  verifyChannelManifest(readback, publicKeyHex, manifest.version);
  if (sha256(readback) !== sha256(data)) throw new Error("Beta 通道清单回读不一致");
  gh([
    "release",
    "edit",
    betaChannelTag,
    "--repo",
    repository,
    "--draft=false",
    "--prerelease",
    "--latest=false",
    "--notes-file",
    notes,
  ]);
  channel = findRelease(gh, repository, betaChannelTag);
  if (!channel || channel.draft || !channel.prerelease) throw new Error("Beta 通道发布状态不正确");
  return manifest.version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.GITHUB_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || !/^[a-f0-9]{40}$/.test(commit || ""))
    throw new Error("通道同步必须在已验证的应用发布任务中执行");
  const gh = (args) =>
    execFileSync("gh", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const { publicKeyHex } = JSON.parse(
    await readFile(path.join(root, "resources/update-public-key.json"), "utf8"),
  );
  const version = await publishBetaChannel({
    gh,
    repository,
    commit,
    directory: path.join(root, "build/update-channel"),
    publicKeyHex,
  });
  console.log(`Beta 静态更新清单已同步：${version}`);
}
