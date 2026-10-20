#include <MediaInfoDLL/MediaInfoDLL_Static.h>
#include "../../native/common/unicode.hpp"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

struct FakeInfo {
    nlohmann::json data;
    std::wstring field;
};
void* __stdcall MediaInfo_New() { return new FakeInfo; }
#ifndef JAVM_INCOMPLETE_FIXTURE
void __stdcall MediaInfo_Delete(void* handle) { delete static_cast<FakeInfo*>(handle); }
size_t __stdcall MediaInfo_Open(void* handle, const wchar_t* path) {
    try {
#ifdef _WIN32
        const std::filesystem::path file(path);
        const auto pid = GetCurrentProcessId();
#else
        const std::filesystem::path file(javm::toUtf8(std::wstring_view(path)));
        const auto pid = getpid();
#endif
        std::ifstream input(file);
        auto& data = static_cast<FakeInfo*>(handle)->data;
        input >> data;
        auto marker = file; marker += ".pid";
        { std::ofstream output(marker); output << pid; }
        const auto mode = data.value("mode", "normal");
        if (mode == "hang") std::this_thread::sleep_for(std::chrono::seconds(30));
        if (mode == "exit") std::_Exit(19);
        if (mode == "flood") std::cout << std::string(65536, 'x') << std::flush;
        return mode == "open-error" ? 0 : 1;
    } catch (...) { return 0; }
}
const wchar_t* __stdcall MediaInfo_Option(void*, const wchar_t*, const wchar_t*) { return L""; }
size_t __stdcall MediaInfo_Count_Get(void* handle, MediaInfo_stream_C kind, size_t) {
    const auto& data = static_cast<FakeInfo*>(handle)->data;
    if (data.value("mode", "") == "bad-count") return static_cast<size_t>(-1);
    return kind == MediaInfo_Stream_Video ? data.value("videos", size_t{1}) : data.value("audios", size_t{1});
}
const wchar_t* __stdcall MediaInfo_Get(void* handle, MediaInfo_stream_C kind, size_t, const wchar_t* name, MediaInfo_info_C, MediaInfo_info_C) {
    auto& state = *static_cast<FakeInfo*>(handle);
    if (state.data.value("mode", "") == "null-field") return nullptr;
    const auto key = javm::toUtf8(std::wstring_view(name));
    std::string value;
    if (key == "Duration") {
        const auto field = kind == MediaInfo_Stream_Video ? "videoDuration" : kind == MediaInfo_Stream_General ? "generalDuration" : "audioDuration";
        value = state.data.value(field, "2000.5");
    } else if (key == "Width") value = state.data.value("width", "320");
    else if (key == "Height") value = state.data.value("height", "240");
    else if (key == "Format") value = state.data.value("codec", "安全模拟编码");
    else if (key == "Language") value = state.data.value("language", "safe");
    else if (key == "Channel(s)") value = state.data.value("channels", "2");
    state.field = javm::fromUtf8(value);
    return state.field.c_str();
}
#endif
