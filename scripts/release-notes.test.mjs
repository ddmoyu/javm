import assert from "node:assert/strict";
import test from "node:test";
import { changelogEntry, releaseAssetNames, renderReleaseNotes } from "./release-notes.mjs";

const version = "1.2.3-alpha.4";
const options = {
  version,
  repository: "example/safe-app",
  changes: "- 新增安装包。\n- 修复窗口位置。",
  assets: Object.values(releaseAssetNames(version)),
};

test("更新说明只读取目标版本，不混入 Unreleased、旧版和重复版本标题", () => {
  const changelog = [
    "# 更新日志",
    "## Unreleased",
    "- 未发布变化",
    `## ${version} — 2026-10-13`,
    options.changes,
    "## 1.2.3-alpha.3 — 2026-10-12",
    "- 旧版变化",
  ].join("\r\n");
  assert.equal(changelogEntry(changelog, version), options.changes);
  assert.equal(changelogEntry(changelog, "Unreleased"), "- 未发布变化");
});

test("找不到版本或更新内容为空时停止发布", () => {
  assert.throws(() => changelogEntry("## 1.2.3-alpha.40\n- 其他版本", version));
  assert.throws(() => changelogEntry(`## ${version}\n\n## older\n- 旧版`, version));
  assert.throws(() => changelogEntry(`## ${version}`, version));
});

test("下载表格位于说明末尾，两个徽章指向本版本真实附件名称", () => {
  const notes = renderReleaseNotes(options);
  for (const name of options.assets)
    assert.ok(
      notes.includes(`https://github.com/example/safe-app/releases/download/v${version}/${name}`),
    );
  assert.match(notes, /!\[Setup x64\]/);
  assert.match(notes, /!\[Portable x64\]/);
  assert.match(notes.trim().split("\n").at(-1), /^\| Windows \| .+ \|$/);
  assert.ok(!/macOS|Linux|Android|源码提交|mock/.test(notes));
  assert.ok(notes.includes(options.changes));
});

test("缺少任一实际附件时拒绝生成下载表格", () => {
  for (const asset of options.assets)
    assert.throws(() => renderReleaseNotes({ ...options, assets: [asset] }), /缺少对应附件/);
});

test("保留现有 ZIP 名称，阻止版本号注入文件路径", () => {
  assert.equal(releaseAssetNames("1.2.3").portable, "JAVM-1.2.3-windows-x64.zip");
  for (const invalid of ["../1.2.3", "1.2.3/evil", "1.2.3\n", "v1.2.3"])
    assert.throws(() => releaseAssetNames(invalid));
});
