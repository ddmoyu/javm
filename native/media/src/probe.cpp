#include "common.hpp"
#include <windows.h>
#include <MediaInfoDLL/MediaInfoDLL_Static.h>
#include <cmath>
#include <chrono>
#include <memory>
#include <semaphore>

namespace media {
namespace {
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle() = default;
    explicit Handle(HANDLE handle): value(handle) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
struct Library {
    HMODULE value;
    ~Library() { if (value) FreeLibrary(value); }
    template<class T> T function(const char* name) {
        auto address = GetProcAddress(value, name);
        if (!address) throw std::runtime_error("MediaInfo DLL 接口不完整");
        return reinterpret_cast<T>(address);
    }
};
}
Json probeDirect(const fs::path& path) {
    if (!fs::is_regular_file(path)) throw std::runtime_error("媒体文件不存在或无法访问");
    Library library{LoadLibraryExW((executable().parent_path() / "MediaInfo.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)};
    if (!library.value) throw std::runtime_error("MediaInfo.dll 加载失败，请重新构建原生扩展");
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
    if (!open(handle.get(), path.c_str())) throw std::runtime_error("无法读取媒体文件");
    const auto videoTracks = count(handle.get(), MediaInfo_Stream_Video, static_cast<size_t>(-1));
    const auto audioTracks = count(handle.get(), MediaInfo_Stream_Audio, static_cast<size_t>(-1));
    auto value = [&](MediaInfo_stream_C kind, const wchar_t* key) { return std::wstring(get(handle.get(), kind, 0, key, MediaInfo_Info_Text, MediaInfo_Info_Name)); };
    auto number = [&](MediaInfo_stream_C kind, const wchar_t* key) {
        const auto text = value(kind, key);
        wchar_t* end = nullptr;
        const auto result = std::wcstod(text.c_str(), &end);
        return end != text.c_str() && std::isfinite(result) && result > 0 ? result : 0.0;
    };
    auto duration = number(MediaInfo_Stream_Video, L"Duration");
    if (duration == 0) duration = number(MediaInfo_Stream_General, L"Duration");
    if (duration == 0) duration = number(MediaInfo_Stream_Audio, L"Duration");
    return {{"video", videoTracks > 0}, {"audio", audioTracks > 0},
        {"videoTracks", videoTracks}, {"audioTracks", audioTracks},
        {"durationMs", static_cast<int64_t>(std::llround(duration))},
        {"audioChannels", static_cast<int>(number(MediaInfo_Stream_Audio, L"Channel(s)"))},
        {"audioLanguage", utf8(value(MediaInfo_Stream_Audio, L"Language"))},
        {"width", static_cast<int>(number(MediaInfo_Stream_Video, L"Width"))},
        {"height", static_cast<int>(number(MediaInfo_Stream_Video, L"Height"))},
        {"codec", utf8(value(MediaInfo_Stream_Video, L"Format"))}};
}
Json probe(const fs::path& path, const std::atomic_bool& cancelled) {
    // 扫描与下载共用同一上限，所有探测仍运行在可终止的子进程中。
    static std::counting_semaphore<16> slots(16);
    while (!slots.try_acquire_for(std::chrono::milliseconds(25)))
        if (cancelled) throw std::runtime_error("媒体探测已取消");
    struct ReleaseSlot { std::counting_semaphore<16>& value; ~ReleaseSlot() { value.release(); } } release{slots};
    if (cancelled) throw std::runtime_error("媒体探测已取消");
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle read, write;
    if (!CreatePipe(&read.value, &write.value, &attributes, 0) || !SetHandleInformation(read.value, HANDLE_FLAG_INHERIT, 0))
        throw std::runtime_error("无法创建视频探测管道");
    Handle nullInput(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_EXISTING, 0, nullptr));
    if (nullInput.value == INVALID_HANDLE_VALUE) throw std::runtime_error("无法创建视频探测标准输入");
    // 并发启动子进程时只继承自己的管道，避免继承其他探测任务的句柄。
    STARTUPINFOEXW start{}; start.StartupInfo.cb = sizeof(start); start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    start.StartupInfo.hStdInput = nullInput.value; start.StartupInfo.hStdOutput = write.value; start.StartupInfo.hStdError = nullInput.value;
    SIZE_T attributesSize = 0;
    InitializeProcThreadAttributeList(nullptr,1,0,&attributesSize);
    std::vector<unsigned char> attributeBuffer(attributesSize);
    start.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBuffer.data());
    if (!InitializeProcThreadAttributeList(start.lpAttributeList,1,0,&attributesSize)) throw std::runtime_error("无法初始化视频探测句柄列表");
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } cleanup{start.lpAttributeList};
    HANDLE inherited[]{nullInput.value,write.value};
    if (!UpdateProcThreadAttribute(start.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr))
        throw std::runtime_error("无法隔离视频探测句柄");
    auto command = L"\"" + executable().wstring() + L"\" --media-probe \"" + path.wstring() + L"\"";
    PROCESS_INFORMATION process{};
    Handle job(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        throw std::runtime_error("无法创建视频探测进程组");
    if (!CreateProcessW(executable().c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | BELOW_NORMAL_PRIORITY_CLASS, nullptr, nullptr, &start.StartupInfo, &process))
        throw std::runtime_error("无法启动视频探测进程");
    Handle child(process.hProcess), thread(process.hThread);
    if (!AssignProcessToJobObject(job.value, child.value)) {
        TerminateProcess(child.value, 1);
        throw std::runtime_error("无法管理视频探测进程");
    }
    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) throw std::runtime_error("无法恢复视频探测进程");
    CloseHandle(write.value); write.value = nullptr;
    const auto deadline = GetTickCount64() + 15000;
    for (;;) {
        const auto wait = WaitForSingleObject(child.value, 50);
        if (wait == WAIT_OBJECT_0) break;
        if (wait == WAIT_FAILED || cancelled || GetTickCount64() >= deadline) {
            TerminateJobObject(job.value, 1);
            WaitForSingleObject(child.value, 1000);
            throw std::runtime_error(cancelled ? "媒体探测已取消" : "视频探测超时或进程异常");
        }
    }
    char buffer[4096]; DWORD received = 0;
    if (!ReadFile(read.value, buffer, sizeof(buffer), &received, nullptr) || !received)
        throw std::runtime_error("视频探测失败");
    DWORD code = 0;
    if (!GetExitCodeProcess(child.value, &code) || code != 0) throw std::runtime_error("视频探测进程异常退出");
    auto result = Json::parse(buffer, buffer + received);
    if (result.contains("error")) throw std::runtime_error(result.at("error").get<std::string>());
    return result;
}
}
