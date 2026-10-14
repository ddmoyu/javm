#include "files.hpp"
#include "crypto.hpp"
#include <array>
#include <fstream>
#include <set>
#include <sqlite3.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif
namespace javm::update {
std::string utf8(const fs::path &path) {
  const auto value = path.u8string();
  return {value.begin(), value.end()};
}
fs::path fromUtf8(const std::string &text) {
  return fs::path(std::u8string(text.begin(), text.end()));
}
Json readJson(const fs::path &file) {
  if (fs::file_size(file) > 4 * 1024 * 1024)
    throw std::runtime_error("更新记录过大");
  std::ifstream input(file, std::ios::binary);
  return Json::parse(input);
}
void replace(const fs::path &from, const fs::path &to) {
#ifdef _WIN32
  if (!MoveFileExW(from.c_str(), to.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("替换文件失败，请检查占用和权限");
#else
  fs::rename(from, to);
  const int descriptor =
      ::open(to.parent_path().c_str(), O_RDONLY | O_DIRECTORY);
  if (descriptor >= 0) {
    fsync(descriptor);
    ::close(descriptor);
  }
#endif
}
void writeJson(const fs::path &file, const Json &value) {
  fs::create_directories(file.parent_path());
  const auto temp = fs::path(file).concat(".tmp");
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    out << value.dump();
    out.flush();
    if (!out)
      throw std::runtime_error("更新记录保存失败");
  }
#ifdef _WIN32
  HANDLE h = CreateFileW(temp.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                         OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE)
    throw std::runtime_error("更新记录无法持久保存");
  const auto ok = FlushFileBuffers(h);
  CloseHandle(h);
  if (!ok)
    throw std::runtime_error("更新记录无法持久保存");
#else
  const int descriptor = ::open(temp.c_str(), O_RDONLY);
  if (descriptor < 0)
    throw std::runtime_error("更新记录无法持久保存");
  const auto ok = fsync(descriptor);
  ::close(descriptor);
  if (ok)
    throw std::runtime_error("更新记录无法持久保存");
#endif
  replace(temp, file);
}
fs::path safePath(const fs::path &root, const std::string &relative) {
  std::error_code rootError;
  if (fs::is_symlink(fs::symlink_status(root, rootError)))
    throw std::runtime_error("更新根目录不能是链接");
#ifdef _WIN32
  const auto rootAttributes = GetFileAttributesW(root.c_str());
  if (rootAttributes != INVALID_FILE_ATTRIBUTES &&
      (rootAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    throw std::runtime_error("更新根目录不能是重解析点");
#endif
  if (relative.empty() || relative.size() > 1000 || relative[0] == '/' ||
      relative.find('\\') != std::string::npos ||
      relative.find(':') != std::string::npos ||
      relative.find('\0') != std::string::npos)
    throw std::runtime_error("更新包路径无效");
  fs::path result = root;
  for (const auto &part : fromUtf8(relative)) {
    const auto name = utf8(part);
    if (name.empty() || name == "." || name == ".." || name.back() == '.' ||
        name.back() == ' ' ||
        name.find_first_of("\r\n<>\"|?*") != std::string::npos)
      throw std::runtime_error("更新包路径越界");
    auto base = name.substr(0, name.find('.'));
    for (auto &c : base)
      c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
    if (base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
        (base.size() == 4 &&
         (base.starts_with("COM") || base.starts_with("LPT")) &&
         base[3] >= '0' && base[3] <= '9'))
      throw std::runtime_error("更新包使用保留路径");
    result /= part;
    std::error_code ec;
    const auto info = fs::symlink_status(result, ec);
    if (!ec && fs::is_symlink(info))
      throw std::runtime_error("更新路径包含链接");
#ifdef _WIN32
    const auto attributes = GetFileAttributesW(result.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
      throw std::runtime_error("更新路径包含重解析点");
#endif
  }
  return result;
}
void copyFile(const fs::path &from, const fs::path &to) {
  safePath(from.parent_path(), utf8(from.filename()));
  safePath(to.parent_path(), utf8(to.filename()));
  fs::create_directories(to.parent_path());
  fs::copy_file(from, to, fs::copy_options::overwrite_existing);
  fs::permissions(to, fs::status(from).permissions());
#ifdef _WIN32
  HANDLE file = CreateFileW(to.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    throw std::runtime_error("无法持久保存更新文件");
  const auto ok = FlushFileBuffers(file);
  CloseHandle(file);
  if (!ok)
    throw std::runtime_error("无法持久保存更新文件");
#else
  const int file = ::open(to.c_str(), O_RDONLY);
  if (file < 0)
    throw std::runtime_error("无法持久保存更新文件");
  const auto ok = fsync(file);
  ::close(file);
  if (ok)
    throw std::runtime_error("无法持久保存更新文件");
#endif
}
Json unpack(const fs::path &archive, const fs::path &stage,
            const std::atomic<bool> *cancel) {
  std::ifstream input(archive, std::ios::binary);
  std::array<unsigned char, 12> prefix{};
  input.read(reinterpret_cast<char *>(prefix.data()), prefix.size());
  if (!input ||
      std::string(reinterpret_cast<char *>(prefix.data()), 8) != "JAVMUP1\n")
    throw std::runtime_error("更新包格式无效");
  const uint32_t size = uint32_t(prefix[8]) | (uint32_t(prefix[9]) << 8) |
                        (uint32_t(prefix[10]) << 16) |
                        (uint32_t(prefix[11]) << 24);
  if (size == 0 || size > 4 * 1024 * 1024)
    throw std::runtime_error("更新包清单无效");
  std::string text(size, '\0');
  input.read(text.data(), size);
  if (!input)
    throw std::runtime_error("更新包不完整");
  const auto manifest = Json::parse(text);
  const auto &files = manifest.at("files");
  if (manifest.at("schema") != 1 || !files.is_array() || files.empty() ||
      files.size() > 10000)
    throw std::runtime_error("更新包清单无效");
  std::set<std::string> seen;
  uint64_t total = 12 + size;
  std::array<char, 65536> buffer{};
  for (const auto &file : files) {
    const auto name = file.at("path").get<std::string>();
    auto key = name;
    for (auto &c : key)
      c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
    if (!seen.insert(key).second)
      throw std::runtime_error("更新包路径重复");
    const auto target = safePath(stage, name);
    auto bytes = file.at("bytes").get<uint64_t>();
    if (bytes > 1024ull * 1024 * 1024 ||
        total + bytes > 2ull * 1024 * 1024 * 1024)
      throw std::runtime_error("更新包超过大小限制");
    total += bytes;
    fs::create_directories(target.parent_path());
    {
      std::ofstream out(target, std::ios::binary | std::ios::trunc);
      while (bytes) {
        if (cancel && *cancel)
          throw std::runtime_error("更新展开已取消");
        const auto count = static_cast<std::streamsize>(
            std::min<uint64_t>(buffer.size(), bytes));
        input.read(buffer.data(), count);
        if (!input)
          throw std::runtime_error("更新包不完整");
        out.write(buffer.data(), count);
        if (!out)
          throw std::runtime_error("更新暂存失败");
        bytes -= static_cast<uint64_t>(count);
      }
    }
    if (hashFile(target, cancel) != file.at("sha256").get<std::string>())
      throw std::runtime_error("更新文件校验失败");
    fs::permissions(target,
                    file.value("executable", false)
                        ? fs::perms::owner_all | fs::perms::group_read |
                              fs::perms::group_exec | fs::perms::others_read |
                              fs::perms::others_exec
                        : fs::perms::owner_read | fs::perms::owner_write |
                              fs::perms::group_read | fs::perms::others_read);
  }
  if (total != fs::file_size(archive))
    throw std::runtime_error("更新包大小不匹配");
  return files;
}
void snapshot(const fs::path &source, const fs::path &destination) {
  safePath(source, "snapshot-root-check");
  Json files = Json::array();
  fs::create_directories(destination);
  if (fs::exists(source))
    for (const auto &entry : fs::recursive_directory_iterator(source)) {
      const auto relative = utf8(fs::relative(entry.path(), source));
      const auto safe = safePath(source, relative);
      if (entry.is_directory())
        continue;
      if (!entry.is_regular_file())
        throw std::runtime_error("升级快照包含特殊文件");
      const auto target = safePath(destination, relative);
      copyFile(safe, target);
      files.push_back({{"path", relative}, {"sha256", hashFile(target)}});
    }
  writeJson(destination / ".snapshot.json",
            {{"exists", fs::exists(source)}, {"files", files}});
}
void restoreSnapshot(const fs::path &source, const fs::path &destination) {
  const auto manifest = readJson(source / ".snapshot.json");
  for (const auto &file : manifest.at("files")) {
    const auto item = safePath(source, file.at("path"));
    if (hashFile(item) != file.at("sha256").get<std::string>())
      throw std::runtime_error("恢复快照校验失败");
  }
  // 只替换本次明确快照的配置目录；保留失败后的副本以便排查。
  if (fs::exists(destination)) {
    auto failed = fs::path(destination)
                      .concat(".update-failed-" +
                              source.parent_path().filename().string());
    unsigned attempt = 0;
    while (fs::exists(failed))
      failed = fs::path(destination)
                   .concat(".update-failed-" +
                           source.parent_path().filename().string() + "-" +
                           std::to_string(++attempt));
    fs::rename(destination, failed);
  }
  if (manifest.at("exists").get<bool>())
    fs::create_directories(destination);
  for (const auto &file : manifest.at("files"))
    copyFile(safePath(source, file.at("path")),
             safePath(destination, file.at("path")));
}
} // namespace javm::update
