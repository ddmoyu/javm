#pragma once
#include <atomic>
#include <filesystem>
#include <nlohmann/json.hpp>
namespace javm::update {
namespace fs = std::filesystem;
using Json = nlohmann::json;
std::string utf8(const fs::path &path);
fs::path fromUtf8(const std::string &text);
Json readJson(const fs::path &file);
void writeJson(const fs::path &file, const Json &value);
void replace(const fs::path &from, const fs::path &to);
fs::path safePath(const fs::path &root, const std::string &relative);
void copyFile(const fs::path &from, const fs::path &to);
Json unpack(const fs::path &archive, const fs::path &stage,
            const std::atomic<bool> *cancel = nullptr);
void snapshot(const fs::path &source, const fs::path &destination);
void restoreSnapshot(const fs::path &source, const fs::path &destination);
} // namespace javm::update
