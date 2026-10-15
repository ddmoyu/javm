#pragma once
#include <nlohmann/json.hpp>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <string>

namespace javm::probe {
namespace fs = std::filesystem;
using Json = nlohmann::json;
inline constexpr std::size_t outputLimit = 16 * 1024;
inline constexpr auto defaultTimeout = std::chrono::seconds(15);
constexpr unsigned concurrencyLimit(unsigned processors) {
    return processors <= 2 ? 1 : processors > 18 ? 16 : processors - 2;
}
fs::path executablePath();
fs::path pathFromUtf8(const std::string& text);
std::string pathToUtf8(const fs::path& path);
const char* libraryFilename();
Json readDirect(const fs::path& file, const fs::path& library);
Json decodeResult(const std::string& text);
// 仅由原生后台线程调用；worker 仍使用既有 --media-probe 一次性内部入口。
Json inspect(const fs::path& worker, const fs::path& file, const std::atomic_bool& cancelled,
             std::chrono::milliseconds timeout = defaultTimeout);
std::string capture(const fs::path& worker, const fs::path& file, const std::atomic_bool& cancelled,
                    std::chrono::milliseconds timeout);
} // namespace javm::probe
