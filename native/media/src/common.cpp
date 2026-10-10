#include "common.hpp"
#include <windows.h>
#include <objbase.h>
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <array>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace media {
std::wstring wide(const std::string& text) {
    const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (!count && !text.empty()) throw std::runtime_error("路径不是有效的 UTF-8");
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count);
    return result;
}
std::string utf8(const std::wstring& text) {
    const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (!count && !text.empty()) throw std::runtime_error("路径包含无效字符");
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
    return result;
}
std::string pathText(const fs::path& path) { return utf8(path.wstring()); }
std::string pathKey(const fs::path& path) {
    auto text = path.lexically_normal().generic_wstring();
    while (text.size() > 1 && text.back() == L'/') text.pop_back();
    if (text.empty()) return {};
    const int count = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr, 0);
    if (!count) throw std::runtime_error("无法规范化路径");
    std::wstring key(count, L'\0');
    LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, text.data(), static_cast<int>(text.size()), key.data(), count, nullptr, nullptr, 0);
    return utf8(key);
}
bool within(const fs::path& path, const fs::path& root) {
    const auto a = pathKey(path), b = pathKey(root);
    return a == b || a.starts_with(b + "/");
}
bool reparse(const fs::path& path) {
    const auto flags = GetFileAttributesW(path.c_str());
    if (flags == INVALID_FILE_ATTRIBUTES) throw std::runtime_error("无法读取文件属性：" + pathText(path));
    return (flags & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
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
    GUID guid{};
    if (CoCreateGuid(&guid) != S_OK) throw std::runtime_error("无法生成记录 ID");
    wchar_t buffer[40]{};
    StringFromGUID2(guid, buffer, 40);
    return utf8(std::wstring(buffer + 1, 36));
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
    std::wstring buffer(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!size || size == buffer.size()) throw std::runtime_error("无法定位原生扩展");
    buffer.resize(size);
    return fs::path(buffer);
}
}
