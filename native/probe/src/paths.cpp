#include "probe.hpp"
#include "../../common/unicode.hpp"
#ifdef _WIN32
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#else
#include <unistd.h>
#endif
#include <vector>

namespace javm::probe {
fs::path executablePath() {
#ifdef _WIN32
    std::wstring buffer(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!size || size == buffer.size()) throw std::runtime_error("无法定位探测程序");
    buffer.resize(size);
    return fs::path(buffer);
#elif defined(__APPLE__)
    std::uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    if (!size || size > 1024 * 1024) throw std::runtime_error("无法定位探测程序");
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size)) throw std::runtime_error("无法定位探测程序");
    return fs::canonical(buffer.data());
#else
    std::vector<char> buffer(4096);
    while (buffer.size() <= 1024 * 1024) {
        const auto size = readlink("/proc/self/exe", buffer.data(), buffer.size());
        if (size < 0) break;
        if (static_cast<std::size_t>(size) < buffer.size()) return fs::path(std::string(buffer.data(), static_cast<std::size_t>(size)));
        buffer.resize(buffer.size() * 2);
    }
    throw std::runtime_error("无法定位探测程序");
#endif
}
fs::path pathFromUtf8(const std::string& text) {
    if (text.find('\0') != std::string::npos || !isValidUtf8(text)) throw std::runtime_error("媒体路径无效");
#ifdef _WIN32
    return fs::path(fromUtf8(text));
#else
    return fs::path(text);
#endif
}
std::string pathToUtf8(const fs::path& path) {
#ifdef _WIN32
    return toUtf8(std::wstring_view(path.native()));
#else
    const auto& text = path.native();
    if (!isValidUtf8(text)) throw std::runtime_error("媒体路径不是有效 UTF-8");
    return text;
#endif
}
const char* libraryFilename() {
#ifdef _WIN32
    return "MediaInfo.dll";
#elif defined(__APPLE__)
    return "libmediainfo.0.dylib";
#else
    return "libmediainfo.so.0";
#endif
}
} // namespace javm::probe
