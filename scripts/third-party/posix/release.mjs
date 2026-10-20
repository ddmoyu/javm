import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRelease } from "../github.mjs";
import { components, root, run, specification, target, targets } from "./common.mjs";
import { completeRelease, downloadAndVerify, requirePublishedRelease } from "./artifact.mjs";

const [command, component = "all"] = process.argv.slice(2);
if (
  !["plan", "publish"].includes(command) ||
  (component !== "all" && !components.includes(component))
)
  throw new Error("用法：node scripts/third-party/posix/release.mjs plan|publish [组件|all]");
const selected = component === "all" ? components : [component];
const repository = "ddmoyu/javm";
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
  });
if (command === "plan") {
  const include = [];
  for (const platform of targets) {
    for (const name of selected) {
      const spec = await specification(name, platform);
      const release = findRelease(gh, repository, spec.tag);
      if (completeRelease(release, spec)) {
        console.log(`${name} / ${platform}: 已有相同配方，复用 ${spec.tag}`);
        continue;
      }
      if (release) throw new Error(`组件发布未完成，请重跑原组件工作流：${spec.tag}`);
      include.push({ component: name, platform, runner: spec.inputs.environment.runner });
    }
  }
  const outputs = { changed: String(include.length > 0), matrix: JSON.stringify({ include }) };
  if (process.env.GITHUB_OUTPUT)
    for (const [name, value] of Object.entries(outputs))
      await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(JSON.stringify(outputs));
} else {
  if (!targets.includes(target) || selected.length !== 1)
    throw new Error("独立组件必须在目标平台上逐项发布");
  const spec = await specification(component);
  const existing = findRelease(gh, repository, spec.tag);
  if (existing) {
    requirePublishedRelease(existing, spec);
    console.log(`已有相同配方，复用 ${spec.tag}`);
  } else {
    const destination = path.join(root, "build/components-posix", target);
    await mkdir(destination, { recursive: true });
    const notes = path.join(destination, `${component}-notes.txt`);
    await writeFile(
      notes,
      `JAVM ${component} / ${target}\n\n构建指纹：${spec.fingerprint}\n最低系统：${spec.inputs.baseline}\n\n仅包含已验证组件，不作为 JAVM Latest。\n`,
    );
    gh([
      "release",
      "create",
      spec.tag,
      "--repo",
      repository,
      "--draft",
      "--latest=false",
      "--target",
      process.env.GITHUB_SHA || (await run("git", ["rev-parse", "HEAD"], root, true)),
      "--title",
      `${component} / ${target}`,
      "--notes-file",
      notes,
    ]);
    const reserved = findRelease(gh, repository, spec.tag);
    if (!reserved?.draft) throw new Error("无法确认本次组件草稿");
    try {
      const { buildComponent } = await import("./build.mjs");
      const built = await buildComponent(component);
      gh([
        "release",
        "upload",
        spec.tag,
        built.archive,
        `${built.archive}.sha256`,
        path.join(path.dirname(built.archive), `${spec.tag}.json`),
        "--repo",
        repository,
      ]);
      await downloadAndVerify(spec, destination, gh);
      gh(["release", "edit", spec.tag, "--repo", repository, "--draft=false", "--latest=false"]);
      const published = requirePublishedRelease(findRelease(gh, repository, spec.tag), spec);
      console.log(published.html_url);
    } catch (error) {
      const current = findRelease(gh, repository, spec.tag);
      if (current?.draft && current.id === reserved.id) {
        try {
          gh(["release", "delete", spec.tag, "--repo", repository, "--yes"]);
        } catch (cleanupError) {
          console.error(`草稿清理失败：${spec.tag}`, cleanupError);
        }
      }
      throw error;
    }
  }
}
