export function releaseAssetNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(version)) throw new Error("无效的发布版本号");
  const base = `JAVM-${version}-windows-x64`;
  return { setup: `${base}-setup.exe`, portable: `${base}.zip` };
}

export function changelogEntry(changelog, version) {
  const section = changelog
    .replaceAll("\r\n", "\n")
    .split(/(?=^## )/m)
    .find((entry) => entry.split("\n", 1)[0].split(/\s+/)[1] === version);
  const body = section?.includes("\n") ? section.slice(section.indexOf("\n") + 1).trim() : "";
  if (!body) throw new Error("缺少更新日志：" + version);
  return body;
}

export function renderReleaseNotes({ version, changes, repository, assets }) {
  const names = releaseAssetNames(version);
  for (const name of Object.values(names)) {
    if (!assets.includes(name)) throw new Error("下载表格缺少对应附件：" + name);
  }
  const download = (name) =>
    `https://github.com/${repository}/releases/download/v${version}/${name}`;
  const badge = (label, color, name) =>
    `[![${label} x64](https://img.shields.io/badge/${label}-x64-${color}?style=flat-square)](${download(name)})`;
  return [
    "## 更新内容",
    "",
    changes.trim(),
    "",
    "Windows 10/11 x64，需已安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。",
    "Setup 为安装版；Portable 解压后运行 `JAVM.exe`。两者均将数据保存在当前用户目录。",
    "",
    "## 下载",
    "",
    "| 系统 | 下载 |",
    "| --- | --- |",
    `| Windows | ${badge("Setup", "0078D4", names.setup)}<br>${badge("Portable", "2EA44F", names.portable)} |`,
    "",
  ].join("\n");
}
