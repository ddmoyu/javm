#include <windows.h>
#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

namespace {
int fail(const std::wstring& message) {
    MessageBoxW(nullptr, message.c_str(), L"JAVM", MB_OK | MB_ICONERROR);
    return 1;
}
bool start(const std::wstring& file, std::wstring command, const std::wstring& directory) {
    STARTUPINFOW startup{sizeof(STARTUPINFOW)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(file.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, directory.c_str(), &startup, &process))
        return false;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return true;
}
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR args, int) {
    std::vector<wchar_t> buffer(32768);
    const auto length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length || length >= buffer.size()) return fail(L"无法确定程序目录。");
    const auto root = std::filesystem::path(buffer.data()).parent_path();
    const auto host = root / L"javm-win_x64.exe";
    std::error_code error;
    if (!std::filesystem::is_regular_file(host, error))
        return fail(L"离线包文件不完整，请完整解压后运行 JAVM.exe。");
    // The official Neutralino host discovers the installed WebView2 Runtime.
    // Keep the launcher limited to the application entry point and resource path.
    auto rootArgument = root.wstring();
    std::replace(rootArgument.begin(), rootArgument.end(), L'\\', L'/');
    // Forward arguments for official Neutralino diagnostics; always anchor resources to this package.
    const auto command = L"\"" + host.wstring() + L"\" " + args + L" \"--path=" + rootArgument + L"\"";
    if (!start(host.wstring(), command, root.wstring()))
        return fail(L"启动 JAVM 失败，Windows 错误码：" + std::to_wstring(GetLastError()));
    return 0;
}
