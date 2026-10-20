// 仅使用安全虚构字节及注入的传输，不连接网络、不接触用户数据。
#include "download.hpp"
#include "crypto.hpp"
#include <fstream>
#include <iostream>
using namespace javm::update;
void require(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F> void rejects(F fn) {
  bool failed = false;
  try {
    fn();
  } catch (const std::exception &) {
    failed = true;
  }
  require(failed, "expected rejection");
}
void append(const fs::path &file, const std::string &data) {
  std::ofstream stream(file, std::ios::binary | std::ios::app);
  stream << data;
  require(!!stream, "fixture write failed");
}
int main(int argc, char **argv) {
  try {
    require(argc == 2, "temporary fixture directory required");
    const auto root = fromUtf8(argv[1]);
    fs::create_directories(root);
    const std::string body = "safe fictional update bytes";
    const auto reference = root / "reference";
    append(reference, body);
    const Json asset = {{"bytes", body.size()},
                        {"sha256", hashFile(reference)}};
    const std::string
        official = "https://github.com/safe/fixture",
        mirror = "https://mirror.example.com/https://github.com/safe/fixture";
    std::atomic<bool> cancel{false};
    const DownloadProgress progress = [](uint64_t bytes, uint64_t total,
                                         const std::string &, bool) {
      require(bytes <= total, "progress exceeds file size");
    };
    require(updateDownloadSources(Json::object()) ==
                std::vector<std::string>{""},
            "legacy official source");
    require(updateDownloadSources(
                {{"sources", {"https://mirror.example.com/prefix", ""}}})[0] ==
                "https://mirror.example.com/prefix/",
            "normalize mirror");
    for (const auto &prefix :
         {"http://mirror.example.com/", "https://user:pass@mirror.example.com/",
          "https://mirror.example.com/?token=secret",
          "https://mirror.example.com/../", "https://mirror.example.com:443/",
          "https://mirror.example.com/#fragment"})
      rejects([&] { updateDownloadSources({{"sources", {prefix}}}); });
    rejects([&] { updateDownloadSources({{"sources", {"", "", "", ""}}}); });
    int calls = 0;
    auto file = root / "fallback";
    fetchUpdateFile(file, asset, {official, mirror}, "", cancel, progress,
                    [&](const std::string &url, const fs::path &output,
                        uint64_t offset, uint64_t, const std::string &,
                        const std::atomic<bool> &, const TransferProgress &) {
                      ++calls;
                      require(offset == 0,
                              "cross-source bytes must not be resumed");
                      append(output, url == official ? "bad" : body);
                      return TransferResult{url == mirror, false};
                    });
    require(calls == 2 &&
                hashFile(file) == asset.at("sha256").get<std::string>(),
            "fallback hash");
    fetchUpdateFile(file, asset, {mirror, official}, "", cancel, progress,
                    [&](auto &&...) -> TransferResult {
                      throw std::runtime_error(
                          "valid cached file must not download");
                    });
    file = root / "bad-hash";
    calls = 0;
    fetchUpdateFile(
        file, asset, {mirror, official}, "", cancel, progress,
        [&](const std::string &url, const fs::path &output, uint64_t offset,
            uint64_t, const std::string &, const std::atomic<bool> &,
            const TransferProgress &) {
          ++calls;
          require(offset == 0, "hash failure must restart");
          append(output, url == mirror ? std::string(body.size(), 'x') : body);
          return TransferResult{true, false};
        });
    require(calls == 2 &&
                hashFile(file) == asset.at("sha256").get<std::string>(),
            "reject corrupt mirror");
    file = root / "resume";
    rejects([&] {
      fetchUpdateFile(file, asset, {official}, "", cancel, progress,
                      [&](const std::string &, const fs::path &output, uint64_t,
                          uint64_t, const std::string &,
                          const std::atomic<bool> &, const TransferProgress &) {
                        append(output, body.substr(0, 5));
                        return TransferResult{};
                      });
    });
    fetchUpdateFile(
        file, asset, {mirror, official}, "", cancel, progress,
        [&](const std::string &, const fs::path &output, uint64_t offset,
            uint64_t, const std::string &, const std::atomic<bool> &,
            const TransferProgress &) {
          require(offset == 5,
                  "configured previous source must resume before fallback");
          append(output, body.substr(5));
          return TransferResult{true, false};
        });
    file = root / "range";
    append(file, body.substr(0, 5));
    writeJson(fs::path(file).concat(".source.json"), {{"url", mirror}});
    calls = 0;
    fetchUpdateFile(file, asset, {mirror}, "", cancel, progress,
                    [&](const std::string &, const fs::path &output,
                        uint64_t offset, uint64_t, const std::string &,
                        const std::atomic<bool> &, const TransferProgress &) {
                      ++calls;
                      if (calls == 1) {
                        require(offset == 5, "initial resume");
                        return TransferResult{false, true};
                      }
                      require(offset == 0, "range fallback restarts");
                      append(output, body);
                      return TransferResult{true, false};
                    });
    require(calls == 2, "bounded range retry");
    file = root / "cancel";
    calls = 0;
    rejects([&] {
      fetchUpdateFile(file, asset, {official, mirror}, "", cancel, progress,
                      [&](const std::string &, const fs::path &output, uint64_t,
                          uint64_t, const std::string &,
                          const std::atomic<bool> &, const TransferProgress &) {
                        ++calls;
                        append(output, "safe");
                        cancel = true;
                        return TransferResult{};
                      });
    });
    require(calls == 1, "cancel must stop fallback");
    cancel = false;
    file = root / "all-invalid";
    rejects([&] {
      fetchUpdateFile(file, asset, {official, mirror}, "", cancel, progress,
                      [&](const std::string &, const fs::path &output, uint64_t,
                          uint64_t, const std::string &,
                          const std::atomic<bool> &, const TransferProgress &) {
                        append(output, std::string(body.size(), 'x'));
                        return TransferResult{true, false};
                      });
    });
    require(fs::file_size(file) == 0, "invalid bytes must not be reused");
    std::cout << "safe download fixtures passed: source validation, fallback, "
                 "cache, hash, resume, range, cancellation\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
