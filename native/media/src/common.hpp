#pragma once
#include <nlohmann/json.hpp>
#include <atomic>
#include <filesystem>
#include <string>

namespace media {
namespace fs = std::filesystem;
using Json = nlohmann::json;
std::string utf8(const std::wstring& text);
std::wstring wide(const std::string& text);
std::string pathText(const fs::path& path);
std::string pathKey(const fs::path& path);
std::string uuid();
bool within(const fs::path& path, const fs::path& root);
bool reparse(const fs::path& path);
std::string stamp(const fs::path& path);
std::string fastHash(const fs::path& path);
std::string trim(std::string text);
std::string lower(std::string text);
std::string codeKey(const std::string& text);
fs::path executable();
inline constexpr int nfoParserVersion = 2;
Json readNfo(const fs::path& path, std::string* original = nullptr);
std::string writeScrapedNfo(const fs::path& path, const Json& metadata, const Json& source, const std::string& expected);
fs::path saveScrapedArtwork(const fs::path& source, const fs::path& video);
Json probeDirect(const fs::path& path);
Json probe(const fs::path& path, const std::atomic_bool& cancelled);
}
