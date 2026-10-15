export function releaseAssetNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/.test(version))
    throw new Error("无效的发布版本号");
  const base = `JAVM-${version}-windows-x64`;
  return { setup: `${base}-setup.exe`, portable: `${base}.zip` };
}

export function posixAssetNames(version, platform) {
  releaseAssetNames(version);
  if (!["macos-arm64", "macos-x64", "linux-x64"].includes(platform))
    throw new Error("无效的发布平台");
  const base = `JAVM-${version}-${platform}`;
  return platform === "linux-x64"
    ? { appimage: `${base}.AppImage`, deb: `${base}.deb`, portable: `${base}-portable.tar.gz` }
    : { dmg: `${base}.dmg`, portable: `${base}-portable.zip` };
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
  const badge = (label, color, name, arch = "x64") =>
    `[![${label} ${arch.replaceAll("_", " ")}](https://img.shields.io/badge/${label}-${arch}-${color}?style=flat-square)](${download(name)})`;
  const rows = [
    `| Windows | ${badge("Setup", "0078D4", names.setup)}<br>${badge("Portable", "2EA44F", names.portable)} |`,
  ];
  const requirements = [];
  const mac = [];
  for (const platform of ["macos-arm64", "macos-x64", "linux-x64"]) {
    const expected = posixAssetNames(version, platform);
    if (!Object.values(expected).some((name) => assets.includes(name))) continue;
    for (const name of Object.values(expected))
      if (!assets.includes(name)) throw new Error("下载表格缺少对应附件：" + name);
    if (platform === "linux-x64") {
      rows.push(
        `| Ubuntu 24.04 | ${badge("AppImage", "E95420", expected.appimage)}<br>${badge("DEB", "A80030", expected.deb)}<br>${badge("Portable", "2EA44F", expected.portable)} |`,
      );
      requirements.push(
        "Linux 首发支持 Ubuntu 24.04 x64；推荐 DEB，便携包和 AppImage 需要同版本系统的 GTK、WebKitGTK、Secret Service 等依赖。",
      );
    } else {
      const arch = platform.endsWith("arm64") ? "Apple_Silicon" : "Intel_x64";
      mac.push(
        `${badge("DMG", "555555", expected.dmg, arch)} ${badge("Portable", "2EA44F", expected.portable, arch)}`,
      );
    }
  }
  if (mac.length) {
    rows.splice(1, 0, `| macOS | ${mac.join("<br>")} |`);
    requirements.unshift(
      "macOS 13+；DMG 中将 JAVM.app 拖入 Applications。macOS 包未使用 Developer ID 签名或公证。",
    );
  }
  return [
    "## 更新内容",
    "",
    changes.trim(),
    "",
    "Windows 10/11 x64，需已安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。",
    "Setup 为安装版；Portable 解压后运行 `JAVM.exe`。两者均将数据保存在当前用户目录。",
    ...requirements,
    ...(assets.includes("latest.json")
      ? [
          version.includes("-beta.")
            ? "Beta 不进入旧 Tauri 的默认更新通道，旧版用户需手动安装；首次跨版本升级后，后续更新启用新版失败回退。"
            : "旧 Tauri 用户可在应用内升级，仍需满足上述系统要求；Windows 会打开安装向导。首次升级沿用旧版安装机制，后续更新启用新版失败回退。",
        ]
      : []),
    "",
    "## 下载",
    "",
    "| 系统 | 下载 |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
