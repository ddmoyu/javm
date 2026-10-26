import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { metatubeRecipeHash, sha256, verifyMetatubeLite } from "./metatube-lite-profile.mjs";
import { applyMovieDiagnostics } from "./metatube-lite/diagnostics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = new Set(process.argv.slice(2));
for (const option of options)
  if (!["--offline", "--install"].includes(option)) throw new Error(`未知参数：${option}`);
if (
  ![
    ["win32", "x64"],
    ["linux", "x64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
  ].some(([os, arch]) => os === process.platform && arch === process.arch)
)
  throw new Error("尚未适配此 MetaTube 构建平台。");
const target = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;
const binaryName = process.platform === "win32" ? "metatube-server.exe" : "metatube-server";
const offline = options.has("--offline");
const dependencies = JSON.parse(
  await readFile(path.join(root, "scripts/offline-dependencies.json"), "utf8"),
);
const dependency = dependencies.metatube;
const lock = JSON.parse(
  await readFile(path.join(root, "scripts/metatube-lite/source-lock.json"), "utf8"),
);
if (dependency.sourceCommit !== lock.commit || dependency.toolchain !== lock.toolchain)
  throw new Error("MetaTube 源码或工具链锁定记录不一致。");
const output = path.join(
  root,
  process.platform === "win32" ? "build/metatube-lite" : `build/metatube-lite-${target}`,
);
const cache = path.join(root, ".tmp/offline-dependencies");
const sourceCache = path.join(cache, `metatube-source-${lock.commit}`);
await mkdir(output, { recursive: true });

// 所有下载限于源码、查询模板和已知许可证；不下载上游测试或示例媒体。
const inside = (base, relative) => {
  const result = path.resolve(base, relative);
  if (!result.startsWith(path.resolve(base) + path.sep)) throw new Error(`路径越界：${relative}`);
  return result;
};
async function download(file, url, valid) {
  try {
    const bytes = await readFile(file);
    if (valid(bytes)) return bytes;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (offline) throw new Error(`离线缓存缺失或校验失败：${path.basename(file)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!valid(bytes)) throw new Error("下载校验失败");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return bytes;
    } catch (error) {
      if (attempt === 2) throw new Error(`${url}: ${error.message}`);
    }
  }
}
const blobHash = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const pending = [
  ...lock.files.map((file) => ({
    ...file,
    url: `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${file.path}`,
    valid: (bytes) => bytes.length === file.size && blobHash(bytes) === file.sha,
  })),
  ...lock.support.map((file) => ({
    ...file,
    path: `support/${file.path}`,
    valid: (bytes) => sha256(bytes) === file.sha256,
  })),
];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let entry; (entry = pending.shift());)
      await download(inside(sourceCache, entry.path), entry.url, entry.valid);
  }),
);
const source = await mkdtemp(path.join(output, "source-"));
for (const file of lock.files) {
  const target = inside(source, file.path);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(inside(sourceCache, file.path), target);
}

let route = await readFile(path.join(source, "route/route.go"), "utf8");
const publicStart = route.indexOf("\tpublic :=");
const privateStart = route.indexOf("\tprivate :=");
if (publicStart < 0 || privateStart <= publicStart) throw new Error("公开路由补丁不匹配");
route = route.slice(0, publicStart) + route.slice(privateStart);
const reviews =
  '\n\t\treviews := private.Group("/reviews")\n\t\t{\n\t\t\treviews.GET("/:provider/:id", getReview(app))\n\t\t}\n';
if (!route.includes(reviews)) throw new Error("评论路由补丁不匹配");
await writeFile(
  path.join(source, "route/route.go"),
  "// JAVM 修改：移除未使用的图片加工、翻译和评论接口。\n" +
    route.replace(reviews, "").replace('\t"time"\n', ""),
);

await applyMovieDiagnostics(source);

let database = await readFile(path.join(source, "database/database.go"), "utf8");
const dbStart = database.indexOf("\tvar dialector gorm.Dialector");
const dbEnd = database.indexOf("\tdb, err := gorm.Open");
if (dbStart < 0 || dbEnd <= dbStart) throw new Error("数据库补丁不匹配");
database =
  database.slice(0, dbStart) +
  "\tif regexp.MustCompile(`^postgres(ql)?://`).MatchString(cfg.DSN) || len(strings.Fields(cfg.DSN)) >= 3 {\n" +
  '\t\treturn nil, fmt.Errorf("JAVM MetaTube lite supports SQLite only")\n\t}\n' +
  "\tdialector := sqlite.Open(cfg.DSN)\n" +
  database.slice(dbEnd);
await writeFile(
  path.join(source, "database/database.go"),
  "// JAVM 修改：仅保留 SQLite 驱动，缓存表和字段格式沿用上游。\n" +
    database
      .replace("import (\n", 'import (\n\t"fmt"\n')
      .replace('\t"gorm.io/driver/postgres"\n', ""),
);

const datatypePath = path.join(source, "javm-deps/datatypes");
await mkdir(datatypePath, { recursive: true });
for (const file of ["date.go", "LICENSE"])
  await copyFile(path.join(sourceCache, "support/datatypes", file), path.join(datatypePath, file));
let jsonType = await readFile(path.join(sourceCache, "support/datatypes/json_type.go"), "utf8");
const mysqlBlock =
  /\n\tswitch db\.Dialector\.Name\(\) \{\n\tcase "mysql":\n\t\tif v, ok := db\.Dialector\.\(\*mysql\.Dialector\); ok && !strings\.Contains\(v\.ServerVersion, "MariaDB"\) \{\n\t\t\treturn gorm\.Expr\("CAST\(\? AS JSON\)", string\(data\)\)\n\t\t\}\n\t\}\n/g;
if ([...jsonType.matchAll(mysqlBlock)].length !== 2) throw new Error("GORM 数据类型补丁不匹配");
jsonType = jsonType
  .replace(mysqlBlock, "")
  .replace('\t"strings"\n', "")
  .replace('\t"gorm.io/driver/mysql"\n', "");
await writeFile(
  path.join(datatypePath, "json_type.go"),
  "// JAVM 修改：保留上游 JSON 序列化和 SQLite 行为，移除 MySQL 驱动。\n" + jsonType,
);
await writeFile(
  path.join(datatypePath, "go.mod"),
  "module gorm.io/datatypes\n\ngo 1.25.0\n\nrequire gorm.io/gorm v1.31.1\n",
);
const moduleFile = path.join(source, "go.mod");
await writeFile(
  moduleFile,
  (await readFile(moduleFile, "utf8")) + "\nreplace gorm.io/datatypes => ./javm-deps/datatypes\n",
);

// 提前应用上游筛选规则，保留原始顺序及重复项权重，随机算法与上游相同。
const userAgents = JSON.parse(
  await readFile(path.join(sourceCache, "support/useragent/useragent_data.json"), "utf8"),
);
const containsTags = (entry, tags) =>
  new Set(entry.Tags.filter((tag) => tags.some((wanted) => tag.includes(wanted)))).size ===
  tags.length;
const pool = userAgents
  .filter(
    (entry) =>
      containsTags(entry, ["computer"]) &&
      !containsTags(entry, ["mobile"]) &&
      !entry.Tags.some((tag) => tag.includes("Spiders - Search")) &&
      !containsTags(entry, ["Google", "Spiders"]) &&
      !entry.Raw.includes("Mobile"),
  )
  .map((entry) => entry.Raw);
if (
  pool.length !== lock.userAgentCount ||
  sha256(JSON.stringify(pool)) !== lock.userAgentSequenceSha256
)
  throw new Error("User-Agent 集合与上游基线不一致");
await writeFile(
  path.join(source, "common/random/useragent.go"),
  '// JAVM 修改：从锁定的上游数据生成，保留全部候选及重复项权重。\npackage random\n\nimport "math/rand/v2"\n\nvar _userAgents = []string{\n' +
    pool.map((entry) => `\t${JSON.stringify(entry)},`).join("\n") +
    "\n}\n\nfunc UserAgent() string { return _userAgents[rand.IntN(len(_userAgents))] }\n",
);

const environment = {
  ...process.env,
  GOTOOLCHAIN: lock.toolchain,
  CGO_ENABLED: "0",
  GOOS: process.platform === "win32" ? "windows" : process.platform,
  GOARCH: process.arch === "x64" ? "amd64" : "arm64",
  GOAMD64: "v1",
  GOFLAGS: "",
  GOWORK: "off",
};
if (offline) environment.GOPROXY = "off";
async function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: source,
      env: { ...environment, ...extraEnv },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputText = "";
    child.stdout.on("data", (chunk) => {
      outputText += chunk;
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(outputText.trim()) : reject(new Error(`${command} 退出码：${code}`)),
    );
  });
}
const goVersion = await run("go", ["version"]);
if (!goVersion.includes(` ${lock.toolchain} `)) throw new Error(`Go 工具链不匹配：${goVersion}`);
await run("go", [
  "fmt",
  "./route",
  "./engine",
  "./database",
  "./common/random",
  "./provider",
  "./provider/javbus",
  "./provider/fanza",
]);
// 上游来源仍逐文件校验；仅记录本次确定性补丁和 Go 格式化后的三个文件。
// 在测试和编译结束后再次核对，不能把已授权补丁简单排除在完整性检查之外。
const patchedProviderSources = await Promise.all(
  ["provider/javbus/javbus.go", "provider/fanza/fanza.go", "provider/javm_diagnostics.go"].map(
    async (file) => ({ path: file, sha: blobHash(await readFile(inside(source, file))) }),
  ),
);
const providerSources = lock.files.filter(
  (entry) => entry.path.startsWith("provider/") || entry.path.startsWith("engine/register"),
);
const providerSourceHashes = new Map(
  [...providerSources, ...patchedProviderSources].map((file) => [file.path, file.sha]),
);
const unchangedProviderCount = providerSources.filter(
  (file) =>
    file.path.startsWith("provider/") &&
    !patchedProviderSources.some((patched) => patched.path === file.path),
).length;
await run("go", ["mod", "tidy"]);
// 只运行自有安全夹具，不运行上游联网测试；各平台构建均验证诊断分类和请求隔离。
for (const target of ["engine", "route"])
  await copyFile(
    path.join(root, "tests/fixtures/metatube-diagnostics", `${target}_test.go`),
    path.join(source, target, "javm_diagnostics_test.go"),
  );
await copyFile(
  path.join(root, "tests/fixtures/metatube-diagnostics/search_test.go"),
  path.join(source, "engine/javm_search_test.go"),
);
console.log(
  await run(
    "go",
    [
      "test",
      "-mod=readonly",
      "-tags=nomsgpack",
      "-count=1",
      "-run=^TestJAVMDiagnostics",
      "./engine",
      "./route",
    ],
    { GOPROXY: "off" },
  ),
);
const binary = path.join(output, binaryName);
const moduleName = "github.com/metatube-community/metatube-sdk-go";
await run("go", [
  "build",
  "-mod=readonly",
  "-tags=nomsgpack",
  "-trimpath",
  "-ldflags",
  `-s -w -buildid= -X ${moduleName}/internal/version.Version=${dependency.version.slice(1)}-${dependency.profile} -X ${moduleName}/internal/version.GitCommit=${lock.commit.slice(0, 8)}`,
  "-o",
  binary,
  "./cmd/server/main.go",
]);
const buildInfo = await run("go", ["version", "-m", binary]);
for (const removed of [
  "gorm.io/driver/postgres",
  "gorm.io/driver/mysql",
  "github.com/projectdiscovery/",
  "github.com/esimov/pigo",
  "github.com/ugorji/go/codec",
  "github.com/xjasonlyu/",
  "github.com/zijiren233/google-translator",
  "github.com/sashabaranov/go-openai",
])
  if (buildInfo.includes(removed)) throw new Error(`不应保留的依赖：${removed}`);
for (const required of [
  "github.com/gen2brain/jpegli",
  "github.com/tetratelabs/wazero",
  "github.com/robertkrimen/otto",
  "modernc.org/sqlite",
])
  if (!buildInfo.includes(required)) throw new Error(`必需依赖缺失：${required}`);
for (const [file, expected] of providerSourceHashes)
  if (blobHash(await readFile(inside(source, file))) !== expected)
    throw new Error(`来源实现与已验证补丁不一致：${file}`);

const officialArchive = path.join(cache, dependency.file);
if (process.platform === "win32") {
  await download(officialArchive, dependency.url, (bytes) => sha256(bytes) === dependency.sha256);
  const zipScript = String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($env:JAVM_META_BASELINE_ZIP)
try {
  $entry=$archive.GetEntry('metatube-server-windows-amd64.exe')
  if (!$entry) { throw 'Baseline EXE missing from official ZIP' }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $env:JAVM_META_OUTPUT 'metatube-server-official.exe'), $true)
} finally { $archive.Dispose() }
foreach ($name in @('official','lite')) {
  $inputFile=if ($name -eq 'official') {'metatube-server-official.exe'} else {'metatube-server.exe'}
  $zipPath=Join-Path $env:JAVM_META_OUTPUT ('metatube-server-'+$name+'.zip')
  $stream=[IO.File]::Open($zipPath,[IO.FileMode]::Create)
  $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
  try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $env:JAVM_META_OUTPUT $inputFile),'metatube-server.exe',[IO.Compression.CompressionLevel]::Optimal) }
  finally { $zip.Dispose(); $stream.Dispose() }
}`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", zipScript], {
    JAVM_META_BASELINE_ZIP: officialArchive,
    JAVM_META_OUTPUT: output,
  });
}
const receipt = {
  platform: target,
  version: dependency.version,
  profile: dependency.profile,
  sourceCommit: lock.commit,
  sourceSha256: dependency.sha256,
  toolchain: lock.toolchain,
  recipeSha256: await metatubeRecipeHash(),
  providerSourceIntegrity: {
    unchangedFiles: unchangedProviderCount,
    patchedFiles: patchedProviderSources,
  },
  sha256: sha256(await readFile(binary)),
  bytes: (await stat(binary)).size,
};
await writeFile(path.join(output, "installed.json"), JSON.stringify(receipt, null, 2) + "\n");
await writeFile(path.join(output, "build-info.txt"), buildInfo + "\n");
const officialBytes =
  process.platform === "win32"
    ? (await stat(path.join(output, "metatube-server-official.exe"))).size
    : 0;
const officialZipBytes =
  process.platform === "win32"
    ? (await stat(path.join(output, "metatube-server-official.zip"))).size
    : 0;
const liteZipBytes =
  process.platform === "win32"
    ? (await stat(path.join(output, "metatube-server-lite.zip"))).size
    : 0;
const comparison =
  process.platform === "win32"
    ? {
        sourceDirectory: source,
        toolchain: lock.toolchain,
        profile: dependency.profile,
        officialBytes,
        liteBytes: receipt.bytes,
        executableReductionPercent: Number(((1 - receipt.bytes / officialBytes) * 100).toFixed(2)),
        officialZipBytes,
        liteZipBytes,
        zipReductionPercent: Number(((1 - liteZipBytes / officialZipBytes) * 100).toFixed(2)),
        officialDownloadZipBytes: (await stat(officialArchive)).size,
        userAgentEntries: pool.length,
        providerSourceFilesUnchanged: unchangedProviderCount,
        providerSourceFilesPatched: patchedProviderSources.map((file) => file.path),
      }
    : {
        platform: target,
        toolchain: lock.toolchain,
        profile: dependency.profile,
        bytes: receipt.bytes,
        userAgentEntries: pool.length,
      };
await writeFile(
  path.join(output, "size-comparison.json"),
  JSON.stringify(comparison, null, 2) + "\n",
);
const notices = path.join(output, "licenses");
await mkdir(notices, { recursive: true });
for (const [input, name] of [
  ["LICENSE", "MetaTube.txt"],
  ["support/datatypes/LICENSE", "gorm-datatypes.txt"],
  ["support/useragent/LICENSE", "useragent.txt"],
])
  await copyFile(path.join(sourceCache, input), path.join(notices, name));
await writeFile(
  path.join(notices, "modifications.txt"),
  `JAVM ${dependency.profile}; MetaTube ${dependency.version}; source ${lock.commit}.\n` +
    "Modified route registration and database driver selection; omitted image/translation/review routes and face detection.\n" +
    "Narrowed GORM datatypes to upstream Date and JSON types with SQLite behavior; removed MySQL-specific branches.\n" +
    "Generated the unchanged upstream desktop User-Agent pool; built Gin without MessagePack.\n" +
    "Added opt-in request-local movie diagnostics with error categories, result counts and missing field names; omitted raw search summaries.\n" +
    "Propagated asynchronous JavBus search errors and added bounded FANZA response/parse diagnostics.\n" +
    "Preserved valid partial search results, SQLite cache schema, image comparison/decoding and the upstream JavaScript parser.\n",
);
await verifyMetatubeLite(output, dependency);
if (options.has("--install")) {
  const installed = path.join(root, "bin/tools/metatube");
  const licenses = path.join(root, "bin/licenses/metatube-lite");
  await mkdir(installed, { recursive: true });
  await mkdir(licenses, { recursive: true });
  for (const file of [binaryName, "installed.json"])
    await copyFile(path.join(output, file), path.join(installed, file));
  for (const file of ["MetaTube.txt", "gorm-datatypes.txt", "useragent.txt", "modifications.txt"])
    await copyFile(path.join(notices, file), path.join(licenses, file));
  await verifyMetatubeLite(installed, dependency);
}
console.log(JSON.stringify(comparison, null, 2));
