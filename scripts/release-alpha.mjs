import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, repository, readJson, sha256 } from "./third-party/components.mjs";
import { findRelease } from "./third-party/github.mjs";
import { changelogEntry, releaseAssetNames, renderReleaseNotes } from "./release-notes.mjs";
import { collectPosixArtifacts } from "./release-posix.mjs";
import { releaseVersion } from "./update-format.mjs";
import { writeUpdateManifest } from "./update-release.mjs";
import { writeLegacyManifest, verifyLegacyRelease } from "./legacy-update.mjs";

const command = process.argv[2];
const pkg = await readJson(path.join(root, "package.json"));
const config = await readJson(path.join(root, "neutralino.config.json"));
const updateKey = await readJson(path.join(root, "resources/update-public-key.json"));
const tag = "v" + pkg.version;
const { channel } = releaseVersion(pkg.version);
if (config.version !== pkg.version)
  throw new Error("发布版本号必须在 package.json 和 Neutralino 配置中一致");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git(["rev-parse", "HEAD"]);
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const api = (endpoint) => JSON.parse(gh(["api", "repos/" + repository + endpoint]));
const directory = path.join(root, "build/alpha-release");
const recordPath = path.join(directory, "release.json");
function verifySource() {
  if (channel !== "alpha") {
    if (!/^04[a-f0-9]{128}$/.test(updateKey.publicKeyHex || ""))
      throw new Error("请先配置并提交更新公钥，再发布正式版或 Beta");
  }
  if (process.env.GITHUB_REF_NAME !== tag) throw new Error("发布标签与应用版本不一致");
  if (git(["rev-parse", tag + "^{commit}"]) !== commit) throw new Error("发布标签提交不一致");
  git(["merge-base", "--is-ancestor", commit, "origin/dev"]);
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("拒绝发布未提交修改");
}
if (command === "verify-source") {
  verifySource();
  console.log(tag + " / " + commit + " 已验证属于 dev");
} else if (command === "prepare") {
  const bundle = await readJson(path.join(root, "dist/offline/latest.json"));
  const manifest = await readJson(bundle.manifest);
  const validation = await readJson(path.join(root, ".tmp/offline-validation.json"));
  const installer = await readJson(path.join(root, "build/installer/latest.json"));
  const installation = await readJson(path.join(root, ".tmp/installer-validation.json"));
  const names = releaseAssetNames(pkg.version);
  if (
    manifest.version !== pkg.version ||
    manifest.platform !== "windows-x64" ||
    manifest.source.commit !== commit ||
    validation.bundle.sha256 !== bundle.sha256 ||
    !validation.results.length ||
    validation.results.some((result) => !result.ok)
  )
    throw new Error("发布包版本、来源或解压验证记录不匹配");
  if (
    sha256(await readFile(bundle.archive)) !== bundle.sha256 ||
    sha256(await readFile(bundle.manifest)) !== bundle.manifestSha256
  )
    throw new Error("发布包或清单在验证后发生变化");
  if (
    installer.version !== pkg.version ||
    installer.platform !== manifest.platform ||
    installer.commit !== commit ||
    installer.dirty !== manifest.source.dirty ||
    installer.appId !== "net.ddmoyu.javm.neutralino" ||
    installer.name !== names.setup ||
    installer.portableArchiveSha256 !== bundle.sha256 ||
    installer.manifestSha256 !== bundle.manifestSha256 ||
    installation.version !== pkg.version ||
    installation.installerSha256 !== installer.sha256 ||
    installation.manifestSha256 !== bundle.manifestSha256 ||
    installation.results?.length !== 3 ||
    installation.results.some((result) => !result.ok) ||
    (await stat(installer.installer)).size !== installer.bytes ||
    sha256(await readFile(installer.installer)) !== installer.sha256
  )
    throw new Error("安装包与便携包、来源或安装验证记录不匹配");
  await mkdir(directory, { recursive: true });
  const name = "JAVM-" + pkg.version + "-windows-x64";
  const files = [
    names.portable,
    name + "-manifest.json",
    "THIRD-PARTY-NOTICES.txt",
    "verification.json",
    names.setup,
  ];
  await copyFile(bundle.archive, path.join(directory, files[0]));
  await copyFile(bundle.manifest, path.join(directory, files[1]));
  await copyFile(installer.installer, path.join(directory, names.setup));
  if (!bundle.updatePackage) throw new Error("便携包缺少更新附件");
  if (sha256(await readFile(bundle.updatePackage)) !== bundle.updatePackageSha256)
    throw new Error("更新附件在打包后发生变化");
  const updateName = `JAVM-${pkg.version}-windows-x64-update.jup`;
  await copyFile(bundle.updatePackage, path.join(directory, updateName));
  files.push(updateName);
  await writeFile(
    path.join(directory, files[2]),
    manifest.licenseNotices
      .map((notice) => notice.components.join(" / ") + "\n" + "=".repeat(72) + "\n" + notice.text)
      .join("\n\n"),
  );
  await writeFile(
    path.join(directory, files[3]),
    JSON.stringify(
      {
        version: pkg.version,
        commit,
        archiveSha256: bundle.sha256,
        results: validation.results,
        installer: {
          name: installer.name,
          sha256: installer.sha256,
          compilerSha256: installer.compilerSha256,
          results: installation.results,
        },
        componentReleases: manifest.componentReleases,
      },
      null,
      2,
    ) + "\n",
  );
  const inventory = [];
  for (const file of files) {
    const data = await readFile(path.join(directory, file));
    inventory.push({ name: file, bytes: data.length, sha256: sha256(data) });
  }
  const sums = inventory.map((file) => file.sha256 + "  " + file.name).join("\n") + "\n";
  await writeFile(path.join(directory, "SHA256SUMS"), sums);
  inventory.push({ name: "SHA256SUMS", bytes: Buffer.byteLength(sums), sha256: sha256(sums) });
  await writeFile(
    recordPath,
    JSON.stringify(
      { tag, version: pkg.version, commit, dirty: manifest.source.dirty, files: inventory },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ tag, bytes: bundle.bytes, sha256: bundle.sha256 }));
} else if (command === "merge-posix") {
  verifySource();
  const record = await readJson(recordPath);
  if (record.tag !== tag || record.commit !== commit || record.dirty)
    throw new Error("发布记录与当前已提交版本不一致");
  const posix = await collectPosixArtifacts({
    version: pkg.version,
    commit,
    source: path.join(root, "build/posix-artifacts"),
    destination: directory,
  });
  const files = [...record.files.filter((file) => file.name !== "SHA256SUMS"), ...posix];
  if (new Set(files.map((file) => file.name)).size !== files.length)
    throw new Error("合并发布附件存在重名");
  if (channel !== "alpha") {
    files.push(
      await writeUpdateManifest(
        directory,
        pkg.version,
        files,
        path.join(root, "resources/update-public-key.json"),
        process.env.JAVM_UPDATE_PRIVATE_KEY,
      ),
    );
    files.push(
      ...(await writeLegacyManifest(
        directory,
        pkg.version,
        files,
        changelogEntry(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), pkg.version),
      )),
    );
  }
  const sums = files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n";
  await writeFile(path.join(directory, "SHA256SUMS"), sums);
  files.push({ name: "SHA256SUMS", bytes: Buffer.byteLength(sums), sha256: sha256(sums) });
  await writeFile(
    recordPath,
    JSON.stringify(
      { ...record, files, platforms: ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"] },
      null,
      2,
    ) + "\n",
  );
  console.log("三系统、四架构的安装包、便携包和验证记录已合并");
} else if (command === "notes") {
  const changes = changelogEntry(
    await readFile(path.join(root, "CHANGELOG.md"), "utf8"),
    process.argv.includes("--unreleased") ? "Unreleased" : pkg.version,
  );
  const notes = renderReleaseNotes({
    version: pkg.version,
    repository,
    changes,
    assets: Object.values(releaseAssetNames(pkg.version)),
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "notes-preview.md"), notes);
  console.log(path.join(directory, "notes-preview.md"));
} else if (command === "publish") {
  verifySource();
  const record = await readJson(recordPath);
  if (record.tag !== tag || record.commit !== commit || record.dirty)
    throw new Error("拒绝发布其他提交或未提交源码构建的附件");
  if (
    ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"].some(
      (platform) => !record.platforms?.includes(platform),
    )
  )
    throw new Error("跨平台发布记录不完整，请先合并已验证的平台附件");
  const assets = [];
  if (channel !== "alpha") {
    const legacyKey = await readJson(path.join(root, "resources/legacy-update-public-key.json"));
    await verifyLegacyRelease(directory, pkg.version, record.files, legacyKey.publicKey);
    if (!record.files.some((file) => file.name === "JAVM-update.json"))
      throw new Error("缺少新版更新清单，禁止公开发布");
  }
  for (const file of record.files) {
    if (path.basename(file.name) !== file.name) throw new Error("非法发布文件名");
    const absolute = path.join(directory, file.name);
    if (
      (await stat(absolute)).size !== file.bytes ||
      sha256(await readFile(absolute)) !== file.sha256
    )
      throw new Error("发布附件校验失败：" + file.name);
    assets.push(absolute);
  }
  let release = findRelease(gh, repository, tag);
  if (release && !release.draft) throw new Error("拒绝覆盖已发布版本");
  const notes = path.join(directory, "notes.md");
  await writeFile(
    notes,
    renderReleaseNotes({
      version: pkg.version,
      repository,
      changes: changelogEntry(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), pkg.version),
      assets: record.files.map((file) => file.name),
    }),
  );
  if (!release) {
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      `--prerelease=${channel !== "stable"}`,
      `--latest=${channel === "stable"}`,
      "--title",
      "JAVM " + pkg.version,
      "--notes-file",
      notes,
    ]);
  } else {
    gh(["release", "edit", tag, "--repo", repository, "--notes-file", notes]);
  }
  gh(["release", "upload", tag, ...assets, "--repo", repository, "--clobber"]);
  release = findRelease(gh, repository, tag);
  const readback = await mkdtemp(path.join(directory, "readback-"));
  for (const file of record.files) {
    const asset = release.assets.find((entry) => entry.name === file.name);
    if (!asset || asset.size !== file.bytes) throw new Error("远端附件缺失：" + file.name);
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      file.name,
      "--dir",
      readback,
    ]);
    if (sha256(await readFile(path.join(readback, file.name))) !== file.sha256)
      throw new Error("远端附件回读失败：" + file.name);
  }
  gh([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    `--prerelease=${channel !== "stable"}`,
    `--latest=${channel === "stable"}`,
  ]);
  release = api("/releases/tags/" + tag);
  if (release.draft || release.prerelease !== (channel !== "stable"))
    throw new Error("发布通道状态不正确");
  console.log(release.html_url);
} else
  throw new Error(
    "用法：node scripts/release-alpha.mjs verify-source|prepare|merge-posix|notes [--unreleased]|publish",
  );
