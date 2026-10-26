#include "download.hpp"
#include "crypto.hpp"
#include <algorithm>
#include <chrono>
#include <curl/curl.h>
#include <fstream>
#include <memory>
#include <regex>
#include <set>
namespace javm::update {
namespace {
TransferResult transferHttp(const std::string &url, const fs::path &file,
                            uint64_t offset, uint64_t expected,
                            const std::string &proxy,
                            const std::atomic<bool> &cancel,
                            const TransferProgress &progress) {
  std::ofstream output(file, std::ios::binary | std::ios::app);
  if (!output)
    throw std::runtime_error("无法写入更新下载");
  struct Transfer {
    std::ofstream &stream;
    uint64_t limit, written;
    const std::atomic<bool> &cancel;
    const TransferProgress &progress;
    std::chrono::steady_clock::time_point last;
    bool failed = false, writeFailed = false;
  } state{output, expected, offset,
          cancel, progress, std::chrono::steady_clock::now()};
  const std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(
      curl_easy_init(), curl_easy_cleanup);
  if (!curl)
    throw std::runtime_error("更新网络初始化失败");
  auto *handle = curl.get();
  curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
  curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(handle, CURLOPT_MAXREDIRS, 5L);
  curl_easy_setopt(handle, CURLOPT_PROTOCOLS_STR, "https");
  curl_easy_setopt(handle, CURLOPT_REDIR_PROTOCOLS_STR, "https");
  curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT, 15L);
  curl_easy_setopt(handle, CURLOPT_TIMEOUT, 3600L);
  curl_easy_setopt(handle, CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(handle, CURLOPT_LOW_SPEED_TIME, 30L);
  curl_easy_setopt(handle, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(handle, CURLOPT_USERAGENT, "JAVM-Updater/1");
#ifdef __APPLE__
  curl_easy_setopt(handle, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
#endif
  curl_easy_setopt(handle, CURLOPT_FAILONERROR, 1L);
  curl_easy_setopt(handle, CURLOPT_PROXY, proxy.c_str());
  curl_easy_setopt(handle, CURLOPT_RESUME_FROM_LARGE,
                   static_cast<curl_off_t>(offset));
  curl_easy_setopt(
      handle, CURLOPT_WRITEFUNCTION,
      +[](char *data, size_t size, size_t count, void *opaque) -> size_t {
        auto &s = *static_cast<Transfer *>(opaque);
        const auto bytes = size * count;
        if (s.cancel || bytes > s.limit - s.written)
          return 0;
        s.stream.write(data, static_cast<std::streamsize>(bytes));
        if (!s.stream) {
          s.writeFailed = true;
          return 0;
        }
        s.written += bytes;
        return bytes;
      });
  curl_easy_setopt(handle, CURLOPT_WRITEDATA, &state);
  curl_easy_setopt(handle, CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(
      handle, CURLOPT_XFERINFOFUNCTION,
      +[](void *opaque, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
        auto &s = *static_cast<Transfer *>(opaque);
        if (s.cancel)
          return 1;
        const auto now = std::chrono::steady_clock::now();
        if (now - s.last > std::chrono::milliseconds(500)) {
          try {
            s.progress(s.written);
          } catch (...) {
            s.failed = true;
            return 1;
          }
          s.last = now;
        }
        return 0;
      });
  curl_easy_setopt(handle, CURLOPT_XFERINFODATA, &state);
  const auto code = curl_easy_perform(handle);
  long http = 0;
  curl_easy_getinfo(handle, CURLINFO_RESPONSE_CODE, &http);
  output.close();
  if (state.failed)
    throw std::runtime_error("更新进度保存失败");
  if (state.writeFailed || output.fail())
    throw std::runtime_error("无法写入更新下载");
  return {code == CURLE_OK && (http == 200 || http == 206),
          offset && (code == CURLE_RANGE_ERROR || http == 416 || http == 200)};
}
} // namespace
std::vector<std::string> updateDownloadSources(const Json &request) {
  const auto sources = request.value("sources", Json::array({""}));
  if (!sources.is_array() || sources.empty() || sources.size() > 4)
    throw std::runtime_error("更新镜像数量无效");
  std::vector<std::string> result;
  std::set<std::string> seen;
  const std::regex prefix(
      "https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?:/[A-Za-z0-9_-]+)*/"
      "?");
  for (const auto &entry : sources) {
    if (!entry.is_string())
      throw std::runtime_error("更新镜像地址无效");
    auto value = entry.get<std::string>();
    if (!value.empty()) {
      if (value.size() > 512 || !std::regex_match(value, prefix))
        throw std::runtime_error("更新镜像地址无效");
      if (value.back() != '/')
        value += '/';
    }
    if (seen.insert(value).second)
      result.push_back(value);
  }
  return result;
}
void fetchUpdateFile(const fs::path &file, const Json &asset,
                     const std::vector<std::string> &urls,
                     const std::string &proxy, const std::atomic<bool> &cancel,
                     const DownloadProgress &progress,
                     const UpdateTransfer &transfer) {
  const auto expected = asset.at("bytes").get<uint64_t>();
  const auto hash = asset.at("sha256").get<std::string>();
  if (!expected || expected > 2ull * 1024 * 1024 * 1024 ||
      !std::regex_match(hash, std::regex("[a-f0-9]{64}")) || urls.empty() ||
      urls.size() > 4)
    throw std::runtime_error("更新附件校验信息无效");
  auto checkCancel = [&] {
    if (cancel)
      throw std::runtime_error("更新下载已取消，可稍后继续");
  };
  checkCancel();
  if (fs::exists(file) && fs::file_size(file) == expected &&
      hashFile(file, &cancel) == hash)
    return;
  const auto sourceFile = fs::path(file).concat(".source.json");
  std::string previous;
  if (fs::exists(sourceFile)) {
    try {
      previous = readJson(sourceFile).value("url", "");
    } catch (...) {
    }
  }
  std::string failure = "更新下载失败，请检查网络后重试，或前往 Release 页面手动更新";
  auto ordered = urls;
  const auto resume = std::find(ordered.begin(), ordered.end(), previous);
  // 继续已选来源的有效残片；只有仍在当前允许列表中才可调整顺序。
  if (resume != ordered.end() && fs::exists(file) && fs::file_size(file) > 0 &&
      fs::file_size(file) < expected)
    std::rotate(ordered.begin(), resume, resume + 1);
  for (const auto &url : ordered) {
    checkCancel();
    // 不把不同来源的部分内容拼接；完整文件始终按官方签名中的哈希校验。
    if (fs::exists(file) &&
        (previous != url || fs::file_size(file) >= expected))
      fs::resize_file(file, 0);
    writeJson(sourceFile, {{"url", url}});
    previous = url;
    const auto host = url.substr(8, url.find('/', 8) - 8);
    for (int attempt = 0; attempt < 2; ++attempt) {
      checkCancel();
      const auto offset = fs::exists(file) ? fs::file_size(file) : 0;
      progress(offset, expected, host, false);
      const auto result = (transfer ? transfer : transferHttp)(
          url, file, offset, expected, proxy, cancel,
          [&](uint64_t bytes) { progress(bytes, expected, host, false); });
      checkCancel();
      if (result.rangeUnsupported && offset && attempt == 0) {
        fs::resize_file(file, 0);
        continue;
      }
      if (!result.ok)
        break;
      progress(fs::file_size(file), expected, host, true);
      if (fs::file_size(file) == expected && hashFile(file, &cancel) == hash)
        return;
      checkCancel();
      failure = "更新包校验失败，所有可用来源均未取得可信文件，请稍后重试";
      fs::resize_file(file, 0);
      break;
    }
  }
  throw std::runtime_error(failure);
}
} // namespace javm::update
