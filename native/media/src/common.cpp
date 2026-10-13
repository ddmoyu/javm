#include "common.hpp"
#include "file_platform.hpp"
#include "probe.hpp"
#include "../../common/unicode.hpp"
#ifdef _WIN32
#include <windows.h>
#include <objbase.h>
#else
#include <unistd.h>
#ifdef __APPLE__
#include <stdlib.h>
#else
#include <sys/random.h>
#endif
#endif
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <array>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <regex>
#include <cerrno>

namespace media {
std::wstring wide(const std::string& text) {
    return javm::fromUtf8(text);
}
std::string utf8(const std::wstring& text) {
    return javm::toUtf8<wchar_t>(text);
}
fs::path pathFromText(const std::string& text) { return javm::probe::pathFromUtf8(text); }
fs::path withSuffix(fs::path path, const std::string& suffix) { return path += pathFromText(suffix); }
std::string pathText(const fs::path& path) { return javm::probe::pathToUtf8(path); }
std::string genericPathText(const fs::path& path) {
    const auto text = path.generic_u8string();
    return std::string(reinterpret_cast<const char*>(text.data()), text.size());
}
std::string pathKey(const fs::path& path) {
    auto text = genericPathText(path.lexically_normal());
    while (text.size() > 1 && text.back() == '/') text.pop_back();
    if (text.empty()) return {};
#ifdef _WIN32
    return unicodeLower(text);
#elif defined(__APPLE__)
    // APFS 可以区分大小写；只在卷明确不区分时折叠，不按操作系统猜测。
    auto existing = path.is_absolute() ? path : fs::absolute(path);
    std::error_code error;
    while (!fs::exists(existing, error) && existing != existing.parent_path()) {
        if (error) throw std::runtime_error("无法读取路径所属文件系统");
        existing = existing.parent_path();
    }
    const auto sensitive = ::pathconf(existing.c_str(), _PC_CASE_SENSITIVE);
    if (sensitive < 0) throw std::runtime_error("无法确认文件系统的大小写规则");
    return sensitive == 0 ? unicodeLower(text) : text;
#else
    return text;
#endif
}
bool within(const fs::path& path, const fs::path& root) {
    const auto a = pathKey(path), b = pathKey(root);
    return !b.empty() && (a == b || a.starts_with(b.back() == '/' ? b : b + "/"));
}
bool reparse(const fs::path& path) {
#ifdef _WIN32
    const auto flags = GetFileAttributesW(path.c_str());
    if (flags == INVALID_FILE_ATTRIBUTES) throw std::runtime_error("无法读取文件属性：" + pathText(path));
    return (flags & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
#else
    return fs::is_symlink(fs::symlink_status(path));
#endif
}
bool hasAlternateStream(const fs::path& path) {
#ifdef _WIN32
    return pathText(path.relative_path()).find(':') != std::string::npos;
#else
    (void)path;
    return false;
#endif
}
bool validFilename(const fs::path& path) {
    const auto name = pathText(path.filename());
    if (name.empty() || name == "." || name == ".." || name.find('\0') != std::string::npos) return false;
#ifdef _WIN32
    if (name.back() == '.' || name.back() == ' ' || name.find_first_of("<>:\"|?*") != std::string::npos ||
        std::any_of(name.begin(), name.end(), [](unsigned char c) { return c < 32; }) ||
        std::regex_match(name, std::regex("(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\\..*)?", std::regex::icase))) return false;
#endif
    return true;
}
std::string stamp(const fs::path& path) {
    return std::to_string(fs::file_size(path)) + ":" + std::to_string(fs::last_write_time(path).time_since_epoch().count());
}
std::string trim(std::string text) {
    const auto begin = text.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return {};
    return text.substr(begin, text.find_last_not_of(" \t\r\n") - begin + 1);
}
// 与旧库兼容：文件长度的小端 uint64 + 文件头尾各 4 KiB 的 Adler-32。
// 这是候选指纹，不是逐字节相同的证明；仅在原生扫描后台读取。
std::string fastHash(const fs::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("无法读取文件指纹：" + pathText(path));
    const uint64_t size = fs::file_size(path);
    if (!size) return "0";
    uint32_t a = 1, b = 0;
    auto update = [&](const unsigned char* data, size_t count) {
        for (size_t i = 0; i < count; ++i) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
    };
    std::array<unsigned char, 8> length{};
    for (size_t i = 0; i < length.size(); ++i) length[i] = static_cast<unsigned char>(size >> (i * 8));
    update(length.data(), length.size());
    std::array<unsigned char, 4096> bytes{};
    auto read = [&](uint64_t offset, size_t count) {
        file.seekg(static_cast<std::streamoff>(offset));
        file.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(count));
        if (file.gcount() != static_cast<std::streamsize>(count)) throw std::runtime_error("文件正在变化，无法计算指纹");
        update(bytes.data(), count);
    };
    read(0, static_cast<size_t>(std::min<uint64_t>(size, 4096)));
    if (size > 4096) {
        const auto offset = size < 8192 ? 4096 : size - 4096;
        read(offset, static_cast<size_t>(size - offset));
    }
    std::ostringstream result;
    result << std::hex << std::setfill('0') << std::setw(8) << ((b << 16) | a);
    return result.str();
}
std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}
std::string uuid() {
#ifdef _WIN32
    GUID guid{};
    if (CoCreateGuid(&guid) != S_OK) throw std::runtime_error("无法生成记录 ID");
    wchar_t buffer[40]{};
    StringFromGUID2(guid, buffer, 40);
    return utf8(std::wstring(buffer + 1, 36));
#else
    std::array<unsigned char, 16> bytes{};
#ifdef __APPLE__
    ::arc4random_buf(bytes.data(), bytes.size());
#else
    size_t done = 0;
    while (done < bytes.size()) {
        const auto count = ::getrandom(bytes.data() + done, bytes.size() - done, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw std::runtime_error("无法生成记录 ID");
        done += static_cast<size_t>(count);
    }
#endif
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    std::ostringstream text;
    text << std::hex << std::setfill('0');
    for (size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) text << '-';
        text << std::setw(2) << static_cast<unsigned>(bytes[i]);
    }
    return text.str();
#endif
}
std::string codeKey(const std::string& text) {
    auto value=wide(text);
    for (auto& c: value) if (c>=0xff01 && c<=0xff5e) c-=0xfee0;
    auto result=lower(utf8(value));
    std::erase_if(result,[](unsigned char c){ return c=='-' || c=='_' || std::isspace(c); });
    if (result.starts_with("fc2ppv")) result.erase(3,3);
    return result;
}
fs::path executable() {
    return javm::probe::executablePath();
}
}
