#include "engine.hpp"
#include "crypto.hpp"
#include "process.hpp"
#include <array>
#include <chrono>
#include <curl/curl.h>
#include <fstream>
#include <random>
#include <regex>
#include <set>
#include <sqlite3.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <sys/stat.h>
#endif
#ifndef JAVM_UPDATE_PUBLIC_KEY
#define JAVM_UPDATE_PUBLIC_KEY ""
#endif
namespace javm::update {
namespace {
constexpr uint64_t maxPackage = 2ull * 1024 * 1024 * 1024;
std::string platform() {
#ifdef _WIN32
  return "windows-x64";
#elif defined(__APPLE__) && defined(__aarch64__)
  return "macos-arm64";
#elif defined(__APPLE__)
  return "macos-x64";
#else
  return "linux-x64";
#endif
}
std::string id() {
  std::random_device random;
  std::array<unsigned char, 16> value{};
  for (auto &c : value)
    c = static_cast<unsigned char>(random());
  return hex(value.data(), value.size());
}
bool finalPhase(const std::string &phase) {
  return phase == "idle" || phase == "committed" || phase == "rolled-back" ||
         phase == "cancelled" || phase == "failed";
}
std::array<int, 5> versionOrder(const std::string &text) {
  std::smatch match;
  if (!std::regex_match(
          text, match,
          std::regex("(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]"
                     "{0,5})(-(alpha|beta)\\.(0|[1-9][0-9]{0,5}))?")))
    throw std::runtime_error("版本格式无效");
  return {std::stoi(match[1]), std::stoi(match[2]), std::stoi(match[3]),
          match[5] == "alpha"  ? 0
          : match[5] == "beta" ? 1
                               : 2,
          match[6].matched ? std::stoi(match[6]) : 0};
}
void status(const fs::path &transaction, const Json &patch) {
  Json value = fs::exists(transaction / "status.json")
                   ? readJson(transaction / "status.json")
                   : Json::object();
  value.update(patch);
  writeJson(transaction / "status.json", value);
}
Json assetFor(const Json &manifest, const std::string &kind) {
  for (const auto &asset : manifest.at("assets"))
    if (asset.at("platform") == platform() && asset.at("kind") == kind)
      return asset;
  throw std::runtime_error("发布未提供当前安装形式的更新包");
}
std::string assetUrl(const Json &manifest, const Json &asset) {
  const auto version = manifest.at("version").get<std::string>(),
             name = asset.at("name").get<std::string>();
  if (!std::regex_match(name, std::regex("JAVM-[A-Za-z0-9._-]+")))
    throw std::runtime_error("更新附件名称无效");
  return "https://github.com/ddmoyu/javm/releases/download/v" + version + "/" +
         name;
}
void validateAsset(const Json &asset) {
  const auto size = asset.at("bytes").get<uint64_t>();
  const auto hash = asset.at("sha256").get<std::string>();
  if (!size || size > maxPackage ||
      !std::regex_match(hash, std::regex("[a-f0-9]{64}")))
    throw std::runtime_error("更新附件校验信息无效");
}
void verifyFile(const fs::path &file, const Json &asset,
                const std::atomic<bool> *cancel = nullptr) {
  validateAsset(asset);
  if (fs::file_size(file) != asset.at("bytes").get<uint64_t>() ||
      hashFile(file, cancel) != asset.at("sha256").get<std::string>())
    throw std::runtime_error("更新包校验失败，请重新下载");
}
void sqliteSnapshot(const fs::path &source, const fs::path &destination) {
  sqlite3 *from = nullptr, *to = nullptr;
  sqlite3_backup *backup = nullptr;
  const auto close = [&] {
    if (backup)
      sqlite3_backup_finish(backup);
    if (to)
      sqlite3_close(to);
    if (from)
      sqlite3_close(from);
  };
  try {
    if (sqlite3_open_v2(utf8(source).c_str(), &from, SQLITE_OPEN_READONLY,
                        nullptr) != SQLITE_OK ||
        sqlite3_open_v2(utf8(destination).c_str(), &to,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                        nullptr) != SQLITE_OK)
      throw std::runtime_error("无法创建更新数据库快照");
    backup = sqlite3_backup_init(to, "main", from, "main");
    if (!backup)
      throw std::runtime_error("数据库快照初始化失败");
    const auto until =
        std::chrono::steady_clock::now() + std::chrono::minutes(2);
    int code = SQLITE_OK;
    do {
      code = sqlite3_backup_step(backup, 256);
      if (code == SQLITE_BUSY || code == SQLITE_LOCKED)
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      if (std::chrono::steady_clock::now() > until)
        throw std::runtime_error("数据库快照超时，原数据保留");
    } while (code == SQLITE_OK || code == SQLITE_BUSY || code == SQLITE_LOCKED);
    if (code != SQLITE_DONE)
      throw std::runtime_error("数据库快照失败");
    sqlite3_backup_finish(backup);
    backup = nullptr;
    close();
  } catch (...) {
    close();
    throw;
  }
}
void snapshotData(const Json &job, const fs::path &transaction) {
  const auto data = fromUtf8(job.at("dataRoot"));
  const auto directory = transaction / "data";
  fs::create_directories(directory);
  Json records = Json::array();
  for (const char *name : {"library.sqlite3", "downloads-v1.sqlite3"}) {
    const auto source = data / name;
    const bool exists = fs::exists(source);
    if (exists)
      sqliteSnapshot(source, directory / name);
    records.push_back({{"name", name},
                       {"exists", exists},
                       {"sha256", exists ? hashFile(directory / name) : ""}});
  }
  snapshot(fromUtf8(job.at("settings")), transaction / "settings");
  writeJson(directory / "manifest.json", records);
}
void restoreData(const Json &job, const fs::path &transaction) {
  const auto data = fromUtf8(job.at("dataRoot"));
  const auto records = readJson(transaction / "data/manifest.json");
  for (const auto &record : records)
    if (record.at("exists").get<bool>() &&
        hashFile(safePath(transaction / "data", record.at("name"))) !=
            record.at("sha256").get<std::string>())
      throw std::runtime_error("更新数据库快照损坏，停止恢复");
  // 提交前不会开放业务；失败副本单独保留，不删除原数据库。
  const auto failed = transaction / ("failed-data-" + id());
  fs::create_directories(failed);
  for (const auto &record : records) {
    const auto name = record.at("name").get<std::string>();
    for (const auto &suffix :
         {std::string(), std::string("-wal"), std::string("-shm")}) {
      const auto target = safePath(data, name + suffix);
      if (fs::exists(target))
        replace(target, safePath(failed, name + suffix));
    }
    if (record.at("exists").get<bool>())
      copyFile(safePath(transaction / "data", name), safePath(data, name));
  }
  restoreSnapshot(transaction / "settings", fromUtf8(job.at("settings")));
}
void installPackage(const Json &job, const fs::path &package) {
  const auto kind = job.at("kind").get<std::string>();
  int result = 1;
#ifdef _WIN32
  if (kind == "setup")
    result = Child(package, {"/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-",
                             "/NORESTART", "/NOCLOSEAPPLICATIONS",
                             "/DIR=" + job.at("root").get<std::string>()})
                 .wait(600);
#else
  if (kind == "deb")
    result =
        Child("/usr/bin/pkexec", {"/usr/bin/dpkg", "--install", utf8(package)})
            .wait(600);
#endif
  if (result != 0)
    throw std::runtime_error(
        "安装器未成功完成，可能取消授权、文件被占用或需要修复系统依赖");
}
void backupProgram(Json &job, const fs::path &transaction) {
  const auto root = fromUtf8(job.at("root"));
  const auto kind = job.at("kind").get<std::string>();
  Json records = Json::array();
  if (kind == "appimage") {
    copyFile(fromUtf8(job.at("entry")), transaction / "previous.AppImage");
    writeJson(transaction / "program-backup.json",
              {{"sha256", hashFile(transaction / "previous.AppImage")}});
    return;
  }
  if (kind == "setup" || kind == "deb")
    return;
  const auto files = job.at("files");
  std::set<std::string> paths;
  for (const auto &file : files)
    paths.insert(file.at("path").get<std::string>());
  for (const auto &file : job.at("owned"))
    paths.insert(file.get<std::string>());
  for (const auto &relative : paths) {
    const auto file = safePath(root, relative);
    const bool exists = fs::exists(file);
    if (exists) {
      if (!fs::is_regular_file(file))
        throw std::runtime_error("更新目标不是普通文件");
      copyFile(file, safePath(transaction / "previous", relative));
    }
    records.push_back(
        {{"path", relative},
         {"exists", exists},
         {"sha256", exists
                        ? hashFile(safePath(transaction / "previous", relative))
                        : ""}});
  }
  writeJson(transaction / "program-backup.json", records);
}
void applyProgram(const Json &job, const fs::path &transaction) {
  const auto kind = job.at("kind").get<std::string>();
  const auto root = fromUtf8(job.at("root"));
  if (kind == "setup" || kind == "deb") {
    installPackage(job, transaction /
                            (kind == "setup" ? "package.exe" : "package.deb"));
    return;
  }
  if (kind == "appimage") {
    const auto entry = fromUtf8(job.at("entry"));
    const auto next = fs::path(entry).concat(".javm-update-new");
    copyFile(transaction / "package.AppImage", next);
    fs::permissions(next, fs::perms::owner_all | fs::perms::group_read |
                              fs::perms::group_exec | fs::perms::others_read |
                              fs::perms::others_exec);
    replace(next, entry);
    return;
  }
  for (const auto &file : job.at("files")) {
    const auto relative = file.at("path").get<std::string>();
    const auto target = safePath(root, relative);
    const auto temporary = fs::path(target).concat(".javm-update-new");
    copyFile(safePath(transaction / "stage", relative), temporary);
    replace(temporary, target);
  }
  std::set<std::string> retained;
  for (const auto &file : job.at("files"))
    retained.insert(file.at("path").get<std::string>());
  for (const auto &file : job.at("owned")) {
    const auto relative = file.get<std::string>();
    if (!retained.contains(relative)) {
      const auto target = safePath(root, relative);
      if (fs::is_regular_file(target))
        fs::remove(target);
    }
  }
}
void rollbackProgram(const Json &job, const fs::path &transaction) {
  const auto kind = job.at("kind").get<std::string>();
  const auto root = fromUtf8(job.at("root"));
  if (kind == "setup" || kind == "deb") {
    const auto manifest = verifiedManifest(job.at("rollback"));
    const auto asset = assetFor(manifest, kind);
    const auto file =
        transaction / (kind == "setup" ? "previous.exe" : "previous.deb");
    verifyFile(file, asset);
    installPackage(job, file);
    return;
  }
  if (kind == "appimage") {
    const auto entry = fromUtf8(job.at("entry")),
               next = fs::path(entry).concat(".javm-update-new");
    if (hashFile(transaction / "previous.AppImage") !=
        readJson(transaction / "program-backup.json")
            .at("sha256")
            .get<std::string>())
      throw std::runtime_error("旧 AppImage 快照损坏");
    copyFile(transaction / "previous.AppImage", next);
    replace(next, entry);
    return;
  }
  const auto records = readJson(transaction / "program-backup.json");
  for (const auto &record : records)
    if (record.at("exists").get<bool>() &&
        hashFile(safePath(transaction / "previous", record.at("path"))) !=
            record.at("sha256").get<std::string>())
      throw std::runtime_error("旧程序快照损坏，已保留所有恢复资料");
  for (const auto &record : records) {
    const auto relative = record.at("path").get<std::string>();
    const auto target = safePath(root, relative);
    if (record.at("exists").get<bool>()) {
      const auto next = fs::path(target).concat(".javm-update-new");
      copyFile(safePath(transaction / "previous", relative), next);
      replace(next, target);
    } else if (fs::is_regular_file(target))
      fs::remove(target);
  }
}
std::string packageName(const std::string &kind, bool previous = false) {
  return std::string(previous ? "previous" : "package") +
         (kind == "setup"      ? ".exe"
          : kind == "deb"      ? ".deb"
          : kind == "appimage" ? ".AppImage"
                               : ".jup");
}
void programStep(const Json &job, const fs::path &directory, bool rollback) {
#ifdef __APPLE__
  bool elevate = ::access(fromUtf8(job.at("root")).c_str(), W_OK) != 0;
  for (const auto &file : job.at("files")) {
    auto parent =
        safePath(fromUtf8(job.at("root")), file.at("path")).parent_path();
    while (!fs::exists(parent) && parent != parent.root_path())
      parent = parent.parent_path();
    elevate = elevate || ::access(parent.c_str(), W_OK) != 0;
  }
  if (elevate) {
    const auto shellQuote = [](const std::string &value) {
      std::string out = "'";
      for (char c : value)
        out += c == '\'' ? "'\\''" : std::string(1, c);
      return out + "'";
    };
    const auto command = shellQuote(utf8(executablePath())) + " " +
                         (rollback ? "--rollback-program" : "--program") + " " +
                         shellQuote(utf8(directory));
    std::string quoted = "\"";
    for (char c : command) {
      if (c == '\\' || c == '\"')
        quoted += '\\';
      quoted += c;
    }
    quoted += '\"';
    if (Child("/usr/bin/osascript",
              {"-e",
               "do shell script " + quoted + " with administrator privileges"})
            .wait(600) != 0)
      throw std::runtime_error("未完成 macOS 安装授权，恢复资料已保留");
    return;
  }
#endif
  if (rollback)
    rollbackProgram(job, directory);
  else
    applyProgram(job, directory);
}
} // namespace
void privilegedProgramStep(const fs::path &transaction, bool rollback) {
#ifdef __APPLE__
  const auto directory = fs::canonical(transaction);
  const auto job = readJson(directory / "job.json");
  const auto root = fromUtf8(job.at("root"));
  if (geteuid() != 0 || job.at("kind") != "app" || root.extension() != ".app" ||
      !root.is_absolute() || root != fs::canonical(root) ||
      !std::regex_match(directory.filename().string(),
                        std::regex("[a-f0-9]{32}")) ||
      directory.parent_path() !=
          fs::canonical(fromUtf8(job.at("dataRoot")) / "updates"))
    throw std::runtime_error("授权安装目录无效");
  // 提权后只使用 root 私有的包、解包目录与旧程序快照。用户可写的 job/stage
  // 不能成为授权写入源；回退也不能读取用户可替换的快照。
  const fs::path recovery =
      "/private/var/root/Library/Application Support/JAVM/updates";
  fs::path checked = recovery.root_path();
  for (const auto &part : recovery.relative_path()) {
    checked /= part;
    if (!fs::exists(checked))
      fs::create_directory(checked);
    struct stat metadata{};
    if (::lstat(checked.c_str(), &metadata) || !S_ISDIR(metadata.st_mode) ||
        metadata.st_uid != 0 || (metadata.st_mode & 0022))
      throw std::runtime_error("授权恢复目录的权限不安全");
  }
  const auto secure = recovery / directory.filename();
  struct stat owner{};
  if (::lstat(directory.c_str(), &owner) || !S_ISDIR(owner.st_mode))
    throw std::runtime_error("更新事务来源无效");
  if (rollback && !fs::exists(secure / "ready.json"))
    return;
  if (!fs::exists(secure)) {
    fs::create_directory(secure);
    fs::permissions(secure, fs::perms::owner_all);
  }
  if (!fs::exists(secure / "ready.json")) {
    const auto identityFile = secure / "bundle-id.txt";
    if (Child("/usr/bin/plutil",
              {"-extract", "CFBundleIdentifier", "raw", "-o",
               utf8(identityFile), utf8(root / "Contents/Info.plist")})
            .wait(30) != 0)
      throw std::runtime_error("无法确认原有 JAVM 应用身份");
    std::ifstream identity(identityFile);
    std::string bundleId;
    std::getline(identity, bundleId);
    if (bundleId != "net.ddmoyu.javm")
      throw std::runtime_error("授权目标不是 JAVM 应用");
    const auto manifest = verifiedManifest(job.at("envelope"));
    copyFile(directory / "package.jup", secure / "package.jup");
    verifyFile(secure / "package.jup", assetFor(manifest, "app"));
    auto trusted = job;
    trusted["files"] = unpack(secure / "package.jup", secure / "stage");
    const auto receipt =
        readJson(root / "Contents/Resources/update-installation.json");
    if (receipt.at("app") != "net.ddmoyu.javm" || receipt.at("kind") != "app" ||
        receipt.at("version") != job.at("currentVersion"))
      throw std::runtime_error("原有应用安装记录不匹配");
    trusted["owned"] = receipt.at("owned");
    trusted["ownerUid"] = owner.st_uid;
    backupProgram(trusted, secure);
    writeJson(secure / "job.json", trusted);
    writeJson(secure / "ready.json", {{"ready", true}});
  }
  const auto trusted = readJson(secure / "job.json");
  if (trusted.at("root") != job.at("root") ||
      trusted.at("version") != job.at("version") ||
      trusted.at("ownerUid").get<uid_t>() != owner.st_uid)
    throw std::runtime_error("授权事务身份不匹配");
  if (rollback)
    rollbackProgram(trusted, secure);
  else
    applyProgram(trusted, secure);
#else
  (void)transaction;
  (void)rollback;
  throw std::runtime_error("当前平台不支持此安装步骤");
#endif
}
Json verifiedManifest(const Json &envelope) {
  const auto payload = envelope.at("payload").get<std::string>(),
             signature = envelope.at("signature").get<std::string>();
  if (!verifySignature(payload, signature, JAVM_UPDATE_PUBLIC_KEY))
    throw std::runtime_error("更新签名无效或此构建未配置发布公钥");
  const auto manifest = Json::parse(payload);
  const auto version = manifest.at("version").get<std::string>();
  if (manifest.at("schema") != 1 || manifest.at("app") != "net.ddmoyu.javm" ||
      manifest.at("minimumUpdater") != 1 ||
      !std::regex_match(version,
                        std::regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-"
                                   "9][0-9]*)(-beta\\.(0|[1-9][0-9]*))?")))
    throw std::runtime_error("更新清单不兼容");
  if (manifest.at("channel") !=
      (version.find("-beta.") == std::string::npos ? "stable" : "beta"))
    throw std::runtime_error("更新通道不匹配");
  if (!manifest.at("assets").is_array() || manifest.at("assets").size() > 16)
    throw std::runtime_error("更新附件数量无效");
  versionOrder(version);
  std::set<std::string> entries;
  for (const auto &asset : manifest.at("assets")) {
    validateAsset(asset);
    assetUrl(manifest, asset);
    if (!entries
             .insert(asset.at("platform").get<std::string>() + "/" +
                     asset.at("kind").get<std::string>())
             .second)
      throw std::runtime_error("更新附件重复");
  }
  return manifest;
}
Engine::~Engine() { shutdown(); }
void Engine::shutdown() {
  cancel_ = true;
  if (work_.joinable())
    work_.join();
}
void Engine::publish(const Json &patch) {
  std::lock_guard lock(mutex_);
  state_.update(patch);
  if (!transaction_.empty())
    writeJson(transaction_ / "status.json", state_);
}
Json Engine::request(const std::string &method, const Json &params) {
  if (method == "update.configure") {
    std::lock_guard lock(mutex_);
    if (running_)
      throw std::runtime_error("更新正在下载");
    const auto app = fs::weakly_canonical(fromUtf8(params.at("appPath")));
    const auto self = fs::weakly_canonical(executablePath());
    if (app / "bin" != self.parent_path())
      return {{"available", false}, {"reason", "开发环境或未安装完整更新组件"}};
    const auto receiptPath =
#ifdef __APPLE__
        app.parent_path() / "Resources/update-installation.json";
#else
        app / "update-installation.json";
#endif
    if (!fs::exists(receiptPath))
      return {{"available", false},
              {"reason", "此安装包不支持整包更新，请先手动安装新版"}};
    const auto receipt = readJson(receiptPath);
    if (receipt.at("app") != "net.ddmoyu.javm" ||
        receipt.at("version") != JAVM_VERSION)
      throw std::runtime_error("安装版本记录不匹配");
    const auto kind = fs::exists(app / "installation-kind.json")
                          ? readJson(app / "installation-kind.json")
                                .at("kind")
                                .get<std::string>()
                          : receipt.at("kind").get<std::string>();
    if (!std::set<std::string>{"portable", "setup", "app", "appimage", "deb"}
             .contains(kind))
      throw std::runtime_error("安装形式无效");
    const auto settings = fromUtf8(params.at("settings"));
    if (!settings.is_absolute() || settings.filename() != ".storage")
      throw std::runtime_error("设置路径无效");
    const auto entry = kind == "appimage" ? fromUtf8(environment("APPIMAGE"))
                                          : app /
#ifdef _WIN32
                                                "JAVM.exe";
#else
                                                "JAVM";
#endif
    if (!entry.is_absolute() || !fs::is_regular_file(entry))
      throw std::runtime_error("无法定位当前安装入口");
    const auto root = kind == "appimage" ? entry.parent_path()
                      : kind == "app"    ? app.parent_path().parent_path()
                                         : app;
    context_ = {{"root", utf8(root)},
                {"appPath", utf8(app)},
                {"dataRoot", utf8(dataRoot_)},
                {"settings", utf8(settings)},
                {"kind", kind},
                {"entry", utf8(entry)},
                {"ownerPid", params.at("ownerPid")},
                {"extensionPid", processId()},
                {"ownerIdentity",
                 processIdentity(params.at("ownerPid").get<uint64_t>())},
                {"extensionIdentity", processIdentity(processId())},
                {"currentVersion", JAVM_VERSION},
                {"owned", receipt.at("owned")}};
    if (context_.at("ownerIdentity") == "")
      throw std::runtime_error("无法确认应用进程身份");
    fs::create_directories(dataRoot_ / "updates");
#ifndef _WIN32
    fs::permissions(dataRoot_ / "updates", fs::perms::owner_all);
#endif
    const auto active = dataRoot_ / "updates/active.json";
    if (fs::exists(active)) {
      const auto name = readJson(active).at("id").get<std::string>();
      if (!std::regex_match(name, std::regex("[a-f0-9]{32}")))
        throw std::runtime_error("更新事务编号无效");
      transaction_ = dataRoot_ / "updates" / name;
      if (fs::exists(transaction_ / "status.json"))
        state_ = readJson(transaction_ / "status.json");
      if (fs::exists(transaction_ / "commit.json")) {
        state_["phase"] = "committed";
        state_["needsRecovery"] = false;
      }
      if (state_.value("phase", "") == "downloading" ||
          state_.value("phase", "") == "verifying") {
        state_["phase"] = "cancelled";
        writeJson(transaction_ / "status.json", state_);
      }
      if (environment("JAVM_UPDATE_TRANSACTION") == utf8(transaction_))
        writeJson(
            transaction_ / "trial-process.json",
            {{"pid", processId()}, {"identity", processIdentity(processId())}});
    }
    return {
        {"available", std::string(JAVM_UPDATE_PUBLIC_KEY).size() == 130},
        {"reason", std::string(JAVM_UPDATE_PUBLIC_KEY).empty()
                       ? "此构建未配置更新签名公钥"
                       : ""},
        {"kind", kind},
        {"phase", state_.value("phase", "idle")},
        {"failedVersion",
         fs::exists(dataRoot_ / "updates/failed.json")
             ? readJson(dataRoot_ / "updates/failed.json").value("version", "")
             : ""}};
  }
  if (context_.empty())
    throw std::runtime_error("更新服务尚未初始化");
  if (method == "update.status") {
    std::lock_guard lock(mutex_);
    if (!downloadSession_ && !transaction_.empty() &&
        fs::exists(transaction_ / "status.json"))
      state_ = readJson(transaction_ / "status.json");
    if (!transaction_.empty() && fs::exists(transaction_ / "commit.json"))
      state_["phase"] = "committed";
    return state_;
  }
  if (method == "update.cancel") {
    cancel_ = true;
    if (!running_) {
      if (state_.value("phase", "") == "waiting")
        throw std::runtime_error("安装已准备退出，请等待安装助手完成");
      publish({{"phase", "cancelled"}});
    }
    return Json::object();
  }
  if (method == "update.verify") {
    const auto manifest = verifiedManifest(params.at("envelope"));
    if (manifest.at("version") != params.at("version") ||
        (params.value("channel", "stable") == "stable" &&
         manifest.at("channel") != "stable"))
      throw std::runtime_error("更新版本或通道不匹配");
    for (const auto &asset : manifest.at("assets"))
      if (asset.at("platform") == platform() &&
          asset.at("kind") == context_.at("kind"))
        return asset;
    return nullptr;
  }
  if (method == "update.download") {
    {
      std::lock_guard lock(mutex_);
      if (state_.value("needsRecovery", false))
        throw std::runtime_error("请先恢复上次未完成的更新");
      if (!finalPhase(state_.value("phase", "idle")) &&
          state_.value("phase", "") != "ready")
        throw std::runtime_error("已有更新任务");
    }
    if (work_.joinable())
      work_.join();
    cancel_ = false;
    running_ = true;
    downloadSession_ = true;
    Json downloadRequest = params;
    downloadRequest["resumeTransaction"] = utf8(transaction_);
    {
      std::lock_guard lock(mutex_);
      transaction_.clear();
      state_ = {{"phase", "downloading"}};
    }
    work_ = std::thread([this, downloadRequest] {
      try {
        download(downloadRequest);
      } catch (const std::exception &error) {
        try {
          publish({{"phase", cancel_ ? "cancelled" : "failed"},
                   {"error", error.what()}});
        } catch (...) {
        }
      }
      running_ = false;
    });
    return Json::object();
  }
  if (method == "update.handoff") {
    if (running_)
      throw std::runtime_error("更新包仍在准备");
    if (work_.joinable())
      work_.join();
    if (state_.value("phase", "") != "ready")
      throw std::runtime_error("更新包尚未就绪");
    const auto helper = executablePath().parent_path() /
#ifdef _WIN32
                        "javm_updater.exe";
#else
                        "javm_updater";
#endif
    const auto copy = transaction_ / helper.filename();
    copyFile(helper, copy);
    const auto recovery = transaction_ /
#ifdef _WIN32
                          "recover.cmd";
    std::ofstream(recovery, std::ios::binary)
        << "@echo off\r\nsetlocal "
           "DisableDelayedExpansion\r\n\"%~dp0javm_updater.exe\" --recover "
           "\"%~dp0.\"\r\nif errorlevel 1 pause\r\n";
#else
#ifdef __APPLE__
                          "recover.command";
#else
                          "recover.sh";
#endif
    std::ofstream(recovery, std::ios::binary)
        << "#!/bin/sh\ndir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd) || "
           "exit 1\nexec \"$dir/javm_updater\" --recover \"$dir\"\n";
    fs::permissions(recovery, fs::perms::owner_all);
#endif
    auto job = readJson(transaction_ / "job.json");
    for (const char *key :
         {"ownerPid", "extensionPid", "ownerIdentity", "extensionIdentity",
          "root", "entry", "appPath", "settings", "dataRoot", "owned"})
      job[key] = context_.at(key);
    if (job.at("currentVersion") != JAVM_VERSION)
      throw std::runtime_error("当前版本已变化，请重新检查更新");
    writeJson(transaction_ / "job.json", job);
    fs::remove(transaction_ / "exit-ready.json");
    fs::remove(transaction_ / "exit-cancelled.json");
    publish({{"phase", "waiting"}});
    try {
      Child child(copy, {"--apply", utf8(transaction_)}, true);
      publish({{"phase", "waiting"},
               {"helperPid", child.pid()},
               {"helperIdentity", processIdentity(child.pid())}});
    } catch (...) {
      publish({{"phase", "ready"}, {"error", "无法启动安装助手，请重试"}});
      throw;
    }
    downloadSession_ = false;
    return {{"readyFile", utf8(transaction_ / "exit-ready.json")}};
  }
  if (method == "update.trial") {
    const auto active = environment("JAVM_UPDATE_TRANSACTION");
    if (!active.empty() && transaction_.empty())
      throw std::runtime_error("更新启动记录缺失");
    const bool helperAlive = sameProcess(state_.value("helperPid", uint64_t(0)),
                                         state_.value("helperIdentity", ""));
    if (active.empty() ||
        (!helperAlive && !fs::exists(transaction_ / "commit.json"))) {
      const auto phase = state_.value("phase", "idle");
      if (phase == "installing" || phase == "rolling-back" ||
          phase == "trial" || phase == "backing-up" || phase == "waiting" ||
          state_.value("needsRecovery", false)) {
        if (!helperAlive) {
          auto job = readJson(transaction_ / "job.json");
          for (const char *key : {"ownerPid", "extensionPid", "ownerIdentity",
                                  "extensionIdentity"})
            job[key] = context_.at(key);
          writeJson(transaction_ / "job.json", job);
          const auto saved = transaction_ /
#ifdef _WIN32
                             "javm_updater.exe";
#else
                             "javm_updater";
#endif
          Child child(saved, {"--recover", utf8(transaction_)}, true);
        }
        return {{"trial", false}, {"recovering", true}};
      }
      return {{"trial", false}};
    }
    if (transaction_.empty() || fs::weakly_canonical(fromUtf8(active)) !=
                                    fs::weakly_canonical(transaction_))
      throw std::runtime_error("更新启动事务不匹配");
    const auto job = readJson(transaction_ / "job.json");
    if (job.at("version") != JAVM_VERSION)
      throw std::runtime_error("更新启动版本不匹配");
    return {{"trial", true}};
  }
  if (method == "update.healthy") {
    if (environment("JAVM_UPDATE_TRANSACTION") != utf8(transaction_) ||
        readJson(transaction_ / "job.json").at("version") != JAVM_VERSION)
      throw std::runtime_error("更新确认来源无效");
    writeJson(transaction_ / "healthy.json",
              {{"version", JAVM_VERSION},
               {"transaction", transaction_.filename().string()}});
    return Json::object();
  }
  throw std::runtime_error("未知更新操作");
}
void Engine::download(Json request) {
  const auto manifest = verifiedManifest(request.at("envelope"));
  if (versionOrder(manifest.at("version")) <= versionOrder(JAVM_VERSION))
    throw std::runtime_error("不支持降级或重复安装当前版本");
  if (request.value("channel", "stable") != "beta" &&
      manifest.at("channel") != "stable")
    throw std::runtime_error("正式通道不接收测试版本");
  const auto kind = context_.at("kind").get<std::string>();
  const auto asset = assetFor(manifest, kind);
  validateAsset(asset);
  // 每个版本只复用通过签名验证且目标完全相同的部分下载。
  const auto version = manifest.at("version").get<std::string>();
  bool reuse = false;
  const auto previousTransaction =
      fromUtf8(request.value("resumeTransaction", ""));
  if (!previousTransaction.empty() &&
      fs::exists(previousTransaction / "job.json")) {
    const auto previous = readJson(previousTransaction / "job.json");
    reuse =
        previous.value("version", "") == version &&
        previous.value("kind", "") == kind &&
        previous.value("root", "") == context_.at("root").get<std::string>() &&
        !fs::exists(previousTransaction / "mutation.json") &&
        previous.at("envelope") == request.at("envelope");
  }
  {
    std::lock_guard lock(mutex_);
    transaction_ = reuse ? previousTransaction : dataRoot_ / "updates" / id();
    fs::create_directories(transaction_);
  }
  Json job = context_;
  job["version"] = version;
  job["envelope"] = request.at("envelope");
  job["rollback"] = request.value("rollback", Json());
  writeJson(transaction_ / "job.json", job);
  writeJson(dataRoot_ / "updates/active.json",
            {{"id", transaction_.filename().string()}});
  publish({{"phase", "downloading"},
           {"version", version},
           {"error", ""},
           {"bytes", 0},
           {"total", asset.at("bytes")},
           {"transaction", utf8(transaction_)}});
  const auto proxy = request.value("proxy", "");
  if (proxy.find_first_of("\r\n") != std::string::npos)
    throw std::runtime_error("代理地址无效");
  auto fetch = [&](const Json &record, const Json &item, const fs::path &file) {
    validateAsset(item);
    const auto expected = item.at("bytes").get<uint64_t>();
    if (fs::exists(file) && fs::file_size(file) >= expected) {
      if (fs::file_size(file) == expected &&
          hashFile(file, &cancel_) == item.at("sha256").get<std::string>())
        return;
      fs::rename(file, fs::path(file).concat(".invalid-" + id()));
    }
    for (int attempt = 0; attempt < 2; ++attempt) {
      const auto offset = fs::exists(file) ? fs::file_size(file) : 0;
      if (offset > expected)
        throw std::runtime_error("部分下载大小无效");
      std::ofstream output(file, std::ios::binary | std::ios::app);
      if (!output)
        throw std::runtime_error("无法写入更新下载");
      struct Transfer {
        Engine *engine;
        std::ofstream *stream;
        uint64_t limit, written;
        std::chrono::steady_clock::time_point last;
        bool failed{};
      } transfer{
          this, &output, expected, offset, std::chrono::steady_clock::now(),
          false};
      CURL *curl = curl_easy_init();
      if (!curl)
        throw std::runtime_error("更新网络初始化失败");
      const auto url = assetUrl(record, item);
      curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
      curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
      curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
      curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");
      curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS_STR, "https");
      curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 20L);
      curl_easy_setopt(curl, CURLOPT_TIMEOUT, 3600L);
      curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
      curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 60L);
      curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
      curl_easy_setopt(curl, CURLOPT_USERAGENT, "JAVM-Updater/1");
#ifdef __APPLE__
      curl_easy_setopt(curl, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
#endif
      curl_easy_setopt(curl, CURLOPT_FAILONERROR, 1L);
      curl_easy_setopt(curl, CURLOPT_PROXY, proxy.c_str());
      curl_easy_setopt(curl, CURLOPT_RESUME_FROM_LARGE,
                       static_cast<curl_off_t>(offset));
      curl_easy_setopt(
          curl, CURLOPT_WRITEFUNCTION,
          +[](char *data, size_t size, size_t count, void *opaque) -> size_t {
            auto &t = *static_cast<Transfer *>(opaque);
            const auto bytes = size * count;
            if (t.engine->cancel_ || bytes > t.limit - t.written)
              return 0;
            t.stream->write(data, static_cast<std::streamsize>(bytes));
            if (!*t.stream)
              return 0;
            t.written += bytes;
            return bytes;
          });
      curl_easy_setopt(curl, CURLOPT_WRITEDATA, &transfer);
      curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
      curl_easy_setopt(
          curl, CURLOPT_XFERINFOFUNCTION,
          +[](void *opaque, curl_off_t, curl_off_t, curl_off_t,
              curl_off_t) -> int {
            auto &t = *static_cast<Transfer *>(opaque);
            if (t.engine->cancel_)
              return 1;
            const auto now = std::chrono::steady_clock::now();
            if (now - t.last > std::chrono::milliseconds(500)) {
              try {
                t.engine->publish({{"bytes", t.written}, {"total", t.limit}});
              } catch (...) {
                t.failed = true;
                return 1;
              }
              t.last = now;
            }
            return 0;
          });
      curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &transfer);
      const auto code = curl_easy_perform(curl);
      long http = 0;
      curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http);
      curl_easy_cleanup(curl);
      output.close();
      if (cancel_)
        throw std::runtime_error("更新下载已取消，可稍后继续");
      if (transfer.failed)
        throw std::runtime_error("更新进度保存失败");
      if (offset && code == CURLE_RANGE_ERROR && attempt == 0) {
        fs::resize_file(file, 0);
        continue;
      }
      if (code != CURLE_OK || (http != 200 && http != 206))
        throw std::runtime_error("更新下载失败，请检查网络后重试");
      publish({{"phase", "verifying"}});
      verifyFile(file, item, &cancel_);
      return;
    }
  };
  const auto package = transaction_ / packageName(kind);
  fetch(manifest, asset, package);
  publish({{"phase", "verifying"}, {"bytes", asset.at("bytes")}});
  verifyFile(package, asset, &cancel_);
  if (kind == "setup" || kind == "deb") {
    const auto previous = verifiedManifest(job.at("rollback"));
    if (previous.at("version") != job.at("currentVersion"))
      throw std::runtime_error("未取得当前版本的可信回退包");
    publish({{"phase", "downloading"},
             {"bytes", 0},
             {"total", assetFor(previous, kind).at("bytes")}});
    fetch(previous, assetFor(previous, kind),
          transaction_ / packageName(kind, true));
  } else if (kind != "appimage") {
    const auto stage = transaction_ / "stage";
    if (fs::exists(stage))
      fs::remove_all(stage);
    job["files"] = unpack(package, stage, &cancel_);
  }
  if (cancel_)
    throw std::runtime_error("更新已取消");
  writeJson(transaction_ / "job.json", job);
  publish({{"phase", "ready"},
           {"bytes", asset.at("bytes")},
           {"total", asset.at("bytes")}});
}
void applyUpdate(const fs::path &transaction, bool recover) {
  const auto directory = fs::canonical(transaction);
  TransactionLock guard(directory / "helper.lock");
  const auto initialStatus = readJson(directory / "status.json");
  if (initialStatus.value("phase", "") == "rolled-back" ||
      fs::exists(directory / "commit.json"))
    return;
  auto job = readJson(directory / "job.json");
  const auto data = fromUtf8(job.at("dataRoot"));
  if (directory.parent_path() != fs::canonical(data / "updates") ||
      !std::regex_match(directory.filename().string(),
                        std::regex("[a-f0-9]{32}")))
    throw std::runtime_error("更新恢复路径无效");
  const auto manifest = verifiedManifest(job.at("envelope"));
  const auto kind = job.at("kind").get<std::string>();
  const auto owner = job.at("ownerPid").get<uint64_t>();
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::minutes(3);
  while (sameProcess(owner, job.value("ownerIdentity", "")) ||
         sameProcess(job.value("extensionPid", uint64_t(0)),
                     job.value("extensionIdentity", "")) ||
         (!recover && !fs::exists(directory / "exit-ready.json"))) {
    if (!recover && fs::exists(directory / "exit-cancelled.json")) {
      status(directory,
             {{"phase", "ready"}, {"error", "退出未完成，更新未安装"}});
      return;
    }
    if (std::chrono::steady_clock::now() > deadline) {
      status(directory,
             {{"phase", "ready"}, {"error", "应用未完成退出，更新未安装"}});
      return;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  if (!recover && fs::exists(directory / "exit-cancelled.json")) {
    status(directory,
           {{"phase", "ready"}, {"error", "退出未完成，更新未安装"}});
    return;
  }
  if (fs::exists(directory / "commit.json"))
    return;
  bool changed = fs::exists(directory / "mutation.json");
  std::unique_ptr<Child> trial;
  try {
    if (recover) {
      const auto previous = readJson(directory / "status.json");
      stopProcessTree(previous.value("trialPid", uint64_t(0)),
                      previous.value("trialIdentity", ""));
      if (fs::exists(directory / "trial-process.json")) {
        const auto extension = readJson(directory / "trial-process.json");
        stopProcessTree(extension.at("pid"), extension.at("identity"));
      }
      throw std::runtime_error("恢复未完成的更新");
    }
    verifyFile(directory / packageName(kind), assetFor(manifest, kind));
    const auto root = fromUtf8(job.at("root"));
    if (!fs::is_directory(root) || root == root.root_path())
      throw std::runtime_error("安装目录无效");
    // 退出后从已经验签的归档重新展开，不能直接信任上次进程留下的文件列表。
    if (kind == "portable" || kind == "app") {
      job["files"] = unpack(directory / "package.jup", directory / "stage");
      writeJson(directory / "job.json", job);
    }
    fs::remove(directory / "healthy.json");
    const auto space = fs::space(root);
    if (space.available <
        assetFor(manifest, kind).at("bytes").get<uint64_t>() * 3 +
            64 * 1024 * 1024)
      throw std::runtime_error("磁盘空间不足以保留新旧程序和快照");
    status(directory, {{"phase", "backing-up"}});
    snapshotData(job, directory);
    backupProgram(job, directory);
    writeJson(directory / "mutation.json", {{"version", job.at("version")}});
    status(directory, {{"phase", "installing"}});
    changed = true;
    programStep(job, directory, false);
    status(directory, {{"phase", "trial"}});
    trial = std::make_unique<Child>(fromUtf8(job.at("entry")),
                                    std::vector<std::string>{}, false,
                                    utf8(directory), true);
    status(directory, {{"trialPid", trial->pid()},
                       {"trialIdentity", processIdentity(trial->pid())}});
    const auto until =
        std::chrono::steady_clock::now() + std::chrono::minutes(3);
    while (std::chrono::steady_clock::now() < until) {
      if (!trial->running())
        throw std::runtime_error("新版在启动确认前退出");
      if (fs::exists(directory / "healthy.json")) {
        const auto healthy = readJson(directory / "healthy.json");
        if (healthy.at("version") == job.at("version") &&
            healthy.at("transaction") == directory.filename().string()) {
          writeJson(directory / "commit.json", healthy);
          trial->release();
          status(directory, {{"phase", "committed"},
                             {"error", ""},
                             {"needsRecovery", false}});
          return;
        }
      }
      if (!trial->running())
        throw std::runtime_error("新版在启动确认前退出");
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
    throw std::runtime_error("新版启动确认超时");
  } catch (const std::exception &error) {
    const std::string failure = error.what();
    if (fs::exists(directory / "commit.json"))
      return;
    try {
      if (trial)
        trial->stop();
      if (fs::exists(directory / "trial-process.json")) {
        const auto extension = readJson(directory / "trial-process.json");
        stopProcessTree(extension.at("pid"), extension.at("identity"));
      }
    } catch (...) {
      status(directory, {{"phase", "failed"},
                         {"needsRecovery", true},
                         {"error", "新版进程尚未停止，已保留快照并暂停恢复"}});
      throw;
    }
    writeJson(data / "updates/failed.json", {{"version", job.at("version")}});
    if (changed) {
      status(directory, {{"phase", "rolling-back"}, {"error", failure}});
      try {
        programStep(job, directory, true);
        restoreData(job, directory);
        status(directory, {{"phase", "rolled-back"},
                           {"error", failure},
                           {"needsRecovery", false}});
      } catch (const std::exception &rollback) {
        status(directory,
               {{"phase", "failed"},
                {"needsRecovery", true},
                {"error", std::string("恢复尚未完成，保留旧包和快照：") +
                              rollback.what()}});
        throw;
      }
    } else
      status(directory, {{"phase", "failed"}, {"error", failure}});
    Child previous(fromUtf8(job.at("entry")), {}, true, "", true);
  }
}
} // namespace javm::update
