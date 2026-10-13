#include "probe.hpp"
#include <windows.h>
#include <algorithm>
#include <vector>

namespace javm::probe {
namespace {
struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE handle) : value(handle) {}
    ~Handle() { close(); }
    void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
struct Child {
    Handle job, process, thread;
    bool assigned = false;
    ~Child() {
        if (!process.value) return;
        if (assigned) TerminateJobObject(job.value, 1);
        else TerminateProcess(process.value, 1);
        WaitForSingleObject(process.value, INFINITE);
    }
};
std::wstring quote(const fs::path& path) {
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (wchar_t c : path.native()) {
        if (!c) throw std::runtime_error("媒体路径无效");
        if (c == L'\\') { ++slashes; continue; }
        result.append(c == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
        result.push_back(c);
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}
} // namespace
std::string capture(const fs::path& worker, const fs::path& file, const std::atomic_bool& cancelled, std::chrono::milliseconds timeout) {
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle read, write;
    if (!CreatePipe(&read.value, &write.value, &security, 0) || !SetHandleInformation(read.value, HANDLE_FLAG_INHERIT, 0))
        throw std::runtime_error("无法创建媒体探测管道");
    Handle null(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
    if (null.value == INVALID_HANDLE_VALUE) throw std::runtime_error("无法创建媒体探测标准流");
    STARTUPINFOEXW start{};
    start.StartupInfo.cb = sizeof(start);
    start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    start.StartupInfo.hStdInput = null.value;
    start.StartupInfo.hStdOutput = write.value;
    start.StartupInfo.hStdError = null.value;
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<unsigned char> attributes(size);
    start.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if (!InitializeProcThreadAttributeList(start.lpAttributeList, 1, 0, &size)) throw std::runtime_error("无法初始化探测句柄列表");
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } cleanup{start.lpAttributeList};
    HANDLE inherited[]{null.value, write.value};
    if (!UpdateProcThreadAttribute(start.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr))
        throw std::runtime_error("无法隔离媒体探测句柄");
    Child child;
    child.job.value = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!child.job.value || !SetInformationJobObject(child.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        throw std::runtime_error("无法创建媒体探测进程组");
    auto command = quote(worker) + L" --media-probe " + quote(file);
    if (command.size() >= 32767) throw std::runtime_error("媒体探测路径过长");
    if (cancelled) throw std::runtime_error("媒体探测已取消");
    PROCESS_INFORMATION info{};
    if (!CreateProcessW(worker.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | BELOW_NORMAL_PRIORITY_CLASS,
        nullptr, nullptr, &start.StartupInfo, &info)) throw std::runtime_error("无法启动媒体探测进程");
    child.process.value = info.hProcess;
    child.thread.value = info.hThread;
    if (!AssignProcessToJobObject(child.job.value, child.process.value)) throw std::runtime_error("无法管理媒体探测进程");
    child.assigned = true;
    if (ResumeThread(child.thread.value) == static_cast<DWORD>(-1)) throw std::runtime_error("无法恢复媒体探测进程");
    write.close();
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    std::string output;
    for (;;) {
        if (cancelled) throw std::runtime_error("媒体探测已取消");
        if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("媒体探测超时");
        // 边运行边排空，避免完整结果或异常输出填满管道导致子进程无法退出。
        DWORD available = 0;
        if (!PeekNamedPipe(read.value, nullptr, 0, nullptr, &available, nullptr)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) throw std::runtime_error("媒体探测管道异常");
        }
        if (available) {
            char buffer[4096]; DWORD count = 0;
            if (!ReadFile(read.value, buffer, std::min<DWORD>(available, static_cast<DWORD>(sizeof(buffer))), &count, nullptr)) throw std::runtime_error("媒体探测读取失败");
            if (output.size() + count > outputLimit) throw std::runtime_error("媒体探测输出过长");
            output.append(buffer, count);
            continue;
        }
        const auto waited = WaitForSingleObject(child.process.value, 25);
        if (waited == WAIT_FAILED) throw std::runtime_error("媒体探测进程异常");
        if (waited == WAIT_OBJECT_0) {
            // 退出与最后一批输出可能发生于两次轮询之间，最后再排空一次。
            if (PeekNamedPipe(read.value, nullptr, 0, nullptr, &available, nullptr) && available) continue;
            DWORD code = 0;
            if (!GetExitCodeProcess(child.process.value, &code) || code != 0) throw std::runtime_error("媒体探测进程异常退出");
            return output;
        }
    }
}
} // namespace javm::probe
