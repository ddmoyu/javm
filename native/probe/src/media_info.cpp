#include "probe.hpp"
#include "../../common/unicode.hpp"
#include <MediaInfoDLL/MediaInfoDLL_Static.h>
#include <cmath>
#include <limits>
#include <locale>
#include <memory>
#include <sstream>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#include <locale.h>
#endif

namespace javm::probe {
namespace {
#ifndef _WIN32
class Utf8Locale {
    locale_t value_ = nullptr;
    locale_t previous_ = nullptr;
public:
    Utf8Locale() {
        // ZenLib converts its wchar_t filenames with the current C locale.
        // Scope UTF-8 to this probe thread even when the launcher uses LC_ALL=C.
        for(const auto* name : {"C.UTF-8", "en_US.UTF-8", "UTF-8"}) {
            value_ = newlocale(LC_CTYPE_MASK, name, nullptr);
            if(value_) break;
        }
        if(!value_) throw std::runtime_error("无法初始化 UTF-8 媒体探测环境");
        previous_ = uselocale(value_);
        if(!previous_) { freelocale(value_); throw std::runtime_error("无法设置 UTF-8 媒体探测环境"); }
    }
    ~Utf8Locale() { uselocale(previous_); freelocale(value_); }
    Utf8Locale(const Utf8Locale&) = delete;
    Utf8Locale& operator=(const Utf8Locale&) = delete;
};
#endif
class Library {
#ifdef _WIN32
    HMODULE value_;
#else
    void* value_;
#endif
public:
    explicit Library(const fs::path& path) : value_(nullptr) {
        if (!path.is_absolute()) throw std::runtime_error("MediaInfo 动态库路径必须为绝对路径");
#ifdef _WIN32
        value_ = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
#else
        // 固定随包路径，不回退到工作目录或系统搜索路径。
        value_ = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
#endif
        if (!value_) throw std::runtime_error("MediaInfo 动态库加载失败，请检查软件包");
    }
    ~Library() {
#ifdef _WIN32
        FreeLibrary(value_);
#else
        dlclose(value_);
#endif
    }
    Library(const Library&) = delete;
    Library& operator=(const Library&) = delete;
    template<class T> T function(const char* name) {
#ifdef _WIN32
        const auto address = GetProcAddress(value_, name);
#else
        const auto address = dlsym(value_, name);
#endif
        if (!address) throw std::runtime_error("MediaInfo 动态库接口不完整");
        return reinterpret_cast<T>(address);
    }
};
std::string text(const wchar_t* value) {
    if (!value) throw std::runtime_error("MediaInfo 返回无效字段");
    std::size_t size = 0;
    while (size < 1024 && value[size]) ++size;
    if (size == 1024) throw std::runtime_error("MediaInfo 字段过长");
    return toUtf8(std::wstring_view(value, size));
}
double number(const std::string& value, double maximum) {
    std::istringstream input(value);
    input.imbue(std::locale::classic());
    double result = 0;
    input >> result;
    return input && std::isfinite(result) && result > 0 && result <= maximum ? result : 0;
}
} // namespace
Json readDirect(const fs::path& file, const fs::path& libraryPath) {
    if (!file.is_absolute() || !fs::is_regular_file(file)) throw std::runtime_error("媒体文件不存在或无法访问");
#ifndef _WIN32
    Utf8Locale locale;
#endif
    Library library(libraryPath);
    const auto create = library.function<decltype(&MediaInfo_New)>("MediaInfo_New");
    const auto destroy = library.function<decltype(&MediaInfo_Delete)>("MediaInfo_Delete");
    const auto open = library.function<decltype(&MediaInfo_Open)>("MediaInfo_Open");
    const auto option = library.function<decltype(&MediaInfo_Option)>("MediaInfo_Option");
    const auto get = library.function<decltype(&MediaInfo_Get)>("MediaInfo_Get");
    const auto count = library.function<decltype(&MediaInfo_Count_Get)>("MediaInfo_Count_Get");
    std::unique_ptr<void, decltype(destroy)> handle(create(), destroy);
    if (!handle) throw std::runtime_error("MediaInfo 初始化失败");
    option(handle.get(), L"ParseSpeed", L"0.5");
    option(handle.get(), L"File_TestContinuousFileNames", L"0");
    option(handle.get(), L"File_IsReferenced", L"1");
    const auto path = fromUtf8(pathToUtf8(file));
    const auto opened = open(handle.get(), path.c_str());
    if (opened == 0 || opened == static_cast<std::size_t>(-1)) throw std::runtime_error("无法读取媒体文件");
    const auto videos = count(handle.get(), MediaInfo_Stream_Video, static_cast<std::size_t>(-1));
    const auto audios = count(handle.get(), MediaInfo_Stream_Audio, static_cast<std::size_t>(-1));
    if (videos > 1'000'000 || audios > 1'000'000) throw std::runtime_error("MediaInfo 返回无效轨道数量");
    const auto value = [&](MediaInfo_stream_C kind, const wchar_t* key) { return text(get(handle.get(), kind, 0, key, MediaInfo_Info_Text, MediaInfo_Info_Name)); };
    const auto durationOf = [&](MediaInfo_stream_C kind) { return number(value(kind, L"Duration"), 9'007'199'254'740'991.0); };
    const auto integer = [&](MediaInfo_stream_C kind, const wchar_t* key) { return static_cast<int>(number(value(kind, key), std::numeric_limits<int>::max())); };
    auto duration = durationOf(MediaInfo_Stream_Video);
    if (duration == 0) duration = durationOf(MediaInfo_Stream_General);
    if (duration == 0) duration = durationOf(MediaInfo_Stream_Audio);
    return {{"video", videos > 0}, {"audio", audios > 0}, {"videoTracks", videos}, {"audioTracks", audios},
        {"durationMs", static_cast<std::int64_t>(std::llround(duration))},
        {"audioChannels", integer(MediaInfo_Stream_Audio, L"Channel(s)")},
        {"audioLanguage", value(MediaInfo_Stream_Audio, L"Language")},
        {"width", integer(MediaInfo_Stream_Video, L"Width")}, {"height", integer(MediaInfo_Stream_Video, L"Height")},
        {"codec", value(MediaInfo_Stream_Video, L"Format")}};
}
} // namespace javm::probe
