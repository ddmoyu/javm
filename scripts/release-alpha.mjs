import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, repository, readJson, sha256 } from "./third-party/components.mjs";

const command = process.argv[2];
const pkg = await readJson(path.join(root, "package.json"));
const config = await readJson(path.join(root, "neutralino.config.json"));
const tag = "v" + pkg.version;
if (!/^v\d+\.\d+\.\d+-alpha\.\d+$/.test(tag) || config.version !== pkg.version)
  throw new Error("Alpha 版本号必须在 package.json 和 Neutralino 配置中一致");
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
  await mkdir(directory, { recursive: true });
  const name = "JAVM-" + pkg.version + "-windows-x64";
  const files = [
    name + ".zip",
    name + "-manifest.json",
    "THIRD-PARTY-NOTICES.txt",
    "verification.json",
  ];
  await copyFile(bundle.archive, path.join(directory, files[0]));
  await copyFile(bundle.manifest, path.join(directory, files[1]));
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
} else if (command === "publish") {
  verifySource();
  const record = await readJson(recordPath);
  if (record.tag !== tag || record.commit !== commit || record.dirty)
    throw new Error("拒绝发布其他提交或未提交源码构建的附件");
  const assets = [];
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
  let release;
  try {
    release = api("/releases/tags/" + tag);
  } catch (error) {
    if (!String(error.stderr).includes("HTTP 404")) throw error;
  }
  if (release && !release.draft) throw new Error("拒绝覆盖已发布的 Alpha 版本");
  if (!release) {
    const notes = path.join(directory, "notes.md");
    await writeFile(
      notes,
      "JAVM " +
        pkg.version +
        " 完整便携包（Windows x64）\n\n" +
        "下载 ZIP 后解压，运行 JAVM.exe。需要系统已安装 Evergreen WebView2。\n\n" +
        "已包含精简 FFmpeg、MetaTube、MediaInfo 和 curl，首次启动无需另行下载这些组件。\n" +
        "全部 MetaTube 刮削来源保留；功能验证仅使用安全合成数据与本地 mock。\n\n" +
        "源码提交：" +
        commit +
        "\n\n" +
        "附件包含 SHA-256、组件构建身份、许可证和解压验证记录。\n\n" +
        (await readFile(path.join(root, "CHANGELOG.md"), "utf8")),
    );
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--prerelease",
      "--latest=false",
      "--title",
      "JAVM " + pkg.version,
      "--notes-file",
      notes,
    ]);
  }
  gh(["release", "upload", tag, ...assets, "--repo", repository, "--clobber"]);
  release = api("/releases/tags/" + tag);
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
    "--prerelease",
    "--latest=false",
  ]);
  release = api("/releases/tags/" + tag);
  if (release.draft || !release.prerelease) throw new Error("Alpha 预发布状态不正确");
  console.log(release.html_url);
} else throw new Error("用法：node scripts/release-alpha.mjs verify-source|prepare|publish");
