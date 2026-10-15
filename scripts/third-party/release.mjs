import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  components,
  platforms,
  root,
  repository,
  readJson,
  sha256,
  specification,
} from "./components.mjs";
import { pack } from "./package.mjs";
import { findRelease } from "./github.mjs";

const [command, component = "all"] = process.argv.slice(2);
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
const api = (endpoint, args = []) => JSON.parse(gh(["api", endpoint, ...args]));
const releaseFor = (tag) => findRelease(gh, repository, tag);
const selected = component === "all" ? components : [component];
if (!selected.every((name) => components.includes(name))) throw new Error("未知组件");
const outputRoot = path.join(root, "build/third-party-artifacts");

if (command === "plan") {
  const include = [];
  const publish = [];
  for (const name of selected) {
    const spec = await specification(name);
    const release = await releaseFor(spec.tag);
    if (
      release &&
      !release.draft &&
      !release.prerelease &&
      platforms.every((platform) =>
        release.assets.some((asset) => asset.name === name + "-" + platform + ".zip"),
      ) &&
      release.assets.some((asset) => asset.name === "component-manifest.json")
    ) {
      console.log(name + ": 已有相同构建指纹，跳过 " + spec.tag);
      continue;
    }
    publish.push(name);
    // Reserve the source ref before a long build. The workflow token may not
    // create a tag for an older commit after dev receives workflow changes.
    if (process.env.JAVM_RESERVE_COMPONENT_TAGS === "1") {
      if (!process.env.GITHUB_SHA) throw new Error("组件标签缺少构建提交");
      try {
        const ref = api("repos/" + repository + "/git/ref/tags/" + encodeURIComponent(spec.tag));
        if (ref.object.sha !== process.env.GITHUB_SHA)
          throw new Error("未完成组件标签属于先前构建，请重跑原工作流：" + spec.tag);
      } catch (error) {
        if (!String(error.stderr).includes("HTTP 404")) throw error;
        api("repos/" + repository + "/git/refs", [
          "-f",
          "ref=refs/tags/" + spec.tag,
          "-f",
          "sha=" + process.env.GITHUB_SHA,
        ]);
      }
    }
    for (const platform of platforms) include.push({ component: name, platform });
  }
  const outputs = {
    matrix: JSON.stringify({ include }),
    components: JSON.stringify(publish),
    changed: String(include.length > 0),
  };
  if (process.env.GITHUB_OUTPUT) {
    for (const [name, value] of Object.entries(outputs))
      await appendFile(process.env.GITHUB_OUTPUT, name + "=" + value + "\n");
  }
  console.log(JSON.stringify(outputs));
} else if (command === "pack") {
  if (selected.length !== 1) throw new Error("每次只能打包一个组件");
  await pack(component);
} else if (command === "publish") {
  for (const name of selected) {
    const spec = await specification(name);
    const directory = path.join(outputRoot, name);
    const records = [];
    for (const platform of platforms) {
      const record = await readJson(path.join(directory, "manifest-" + platform + ".json"));
      if (
        record.component !== name ||
        record.platform !== platform ||
        record.fingerprint !== spec.fingerprint ||
        record.tag !== spec.tag ||
        record.commit !== process.env.GITHUB_SHA
      )
        throw new Error("待发布组件构建身份不一致");
      const bytes = await readFile(path.join(directory, record.archive.name));
      if (bytes.length !== record.archive.bytes || sha256(bytes) !== record.archive.sha256)
        throw new Error("待发布 ZIP 校验失败");
      records.push(record);
    }
    const releaseManifest = { schema: 1, ...spec, commit: process.env.GITHUB_SHA, builds: records };
    const manifestPath = path.join(directory, "component-manifest.json");
    const sumsPath = path.join(directory, "SHA256SUMS");
    await writeFile(manifestPath, JSON.stringify(releaseManifest, null, 2) + "\n");
    const assets = [
      ...records.map((record) => path.join(directory, record.archive.name)),
      manifestPath,
    ];
    await writeFile(
      sumsPath,
      (
        await Promise.all(
          assets.map(async (file) => sha256(await readFile(file)) + "  " + path.basename(file)),
        )
      ).join("\n") + "\n",
    );
    assets.push(sumsPath);
    let release = await releaseFor(spec.tag);
    if (release && !release.draft) {
      throw new Error("拒绝覆盖已公开组件 Release：" + spec.tag);
    }
    if (!release) {
      const tagRef = "repos/" + repository + "/git/ref/tags/" + encodeURIComponent(spec.tag);
      try {
        const ref = api(tagRef);
        if (ref.object.sha !== process.env.GITHUB_SHA) throw new Error("组件标签已指向其他提交");
      } catch (error) {
        if (!String(error.stderr).includes("HTTP 404")) throw error;
        api("repos/" + repository + "/git/refs", [
          "-f",
          "ref=refs/tags/" + spec.tag,
          "-f",
          "sha=" + process.env.GITHUB_SHA,
        ]);
      }
      const notes = path.join(directory, "release-notes.md");
      await writeFile(
        notes,
        "# " +
          name +
          " 精简组件\n\n" +
          "- 版本：" +
          spec.version +
          "\n" +
          "- 平台：" +
          platforms.join(", ") +
          "\n" +
          "- 构建提交：" +
          process.env.GITHUB_SHA +
          "\n" +
          "- 构建指纹：" +
          spec.fingerprint +
          "\n\n" +
          "供 JAVM 构建使用。仅包含本组件的运行文件、必要开发文件、许可证和构建记录。\n" +
          "附件已核对架构、功能配置及 SHA-256；内容验证仅使用本地安全合成数据。\n",
      );
      gh([
        "release",
        "create",
        spec.tag,
        "--repo",
        repository,
        "--verify-tag",
        "--draft",
        "--latest=false",
        "--title",
        name + " " + spec.version + " · " + spec.fingerprint.slice(0, 8),
        "--notes-file",
        notes,
      ]);
      release = await releaseFor(spec.tag);
    }
    if (release.target_commitish && release.tag_name !== spec.tag) throw new Error("发布标签异常");
    gh(["release", "upload", spec.tag, ...assets, "--repo", repository, "--clobber"]);
    const published = await releaseFor(spec.tag);
    for (const file of assets) {
      const asset = published.assets.find((entry) => entry.name === path.basename(file));
      if (!asset || asset.size !== (await stat(file)).size) throw new Error("远端附件不完整");
      const check = await mkdtemp(path.join(directory, "readback-"));
      gh([
        "release",
        "download",
        spec.tag,
        "--repo",
        repository,
        "--pattern",
        asset.name,
        "--dir",
        check,
      ]);
      if (sha256(await readFile(path.join(check, asset.name))) !== sha256(await readFile(file)))
        throw new Error("远端附件回读哈希不一致");
    }
    gh(["release", "edit", spec.tag, "--repo", repository, "--draft=false", "--latest=false"]);
    console.log(published.html_url);
  }
} else {
  throw new Error("用法：node scripts/third-party/release.mjs plan|pack|publish [组件|all]");
}
