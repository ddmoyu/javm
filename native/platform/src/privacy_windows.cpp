#include "privacy.hpp"
#include <windows.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <deque>
#include <filesystem>
#include <future>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace javm::platform {
namespace {
using Json = Service::Json;
using Microsoft::WRL::ComPtr;
constexpr UINT runTask = WM_APP + 41, stopService = WM_APP + 42, localBoss = WM_APP + 43;
std::wstring wide(const std::string& value, size_t limit = 32760) {
    if (value.size() > limit || value.find('\0') != std::string::npos) throw std::runtime_error("隐私服务参数无效");
    if (value.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (!size) throw std::runtime_error("隐私服务文本无效");
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}
std::string utf8(const wchar_t* value) {
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
    if (!size) throw std::runtime_error("文件路径编码无效");
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), size, nullptr, nullptr);
    result.pop_back();
    return result;
}
void check(HRESULT status) { if (FAILED(status)) throw std::runtime_error("Windows 隐私服务操作失败"); }
std::wstring processPath(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return {};
    std::wstring path(32768, L'\0');
    DWORD length = static_cast<DWORD>(path.size());
    const bool ok = QueryFullProcessImageNameW(process, 0, path.data(), &length) != FALSE;
    CloseHandle(process);
    return ok ? path.substr(0, length) : std::wstring{};
}
std::wstring quote(const std::wstring& value) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (const auto ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        result.append(ch == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        slashes = 0; result += ch;
    }
    result.append(slashes * 2, L'\\'); result += L'"';
    return result;
}
}

struct Privacy::State {
    DWORD hostPid;
    std::wstring hostPath;
    std::function<void()> bossKey;
    HWND window = nullptr;
    std::thread thread;
    std::mutex mutex;
    std::deque<std::function<void()>> tasks;
    bool stopped = false;
    int hotkeyId = 0;
    UINT activeKey = 0, activeModifiers = 0;
    UINT localKey = VK_F1, localModifiers = 0;
    bool localEnabled = false;
    inline static thread_local State* hookState = nullptr;
    ComPtr<IFileOpenDialog> dialog;
    std::string dialogRequestId;

    State(DWORD pid, std::function<void()> callback): hostPid(pid), hostPath(processPath(pid)), bossKey(std::move(callback)) {
        std::promise<bool> ready;
        auto result = ready.get_future();
        thread = std::thread([this, &ready] {
            const auto initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
            if (FAILED(initialized)) { ready.set_value(false); return; }
            WNDCLASSW type{};
            type.lpfnWndProc = procedure;
            type.hInstance = GetModuleHandleW(nullptr);
            type.lpszClassName = L"JAVMPrivacyService";
            RegisterClassW(&type);
            window = CreateWindowExW(0, type.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, type.hInstance, this);
            ready.set_value(window != nullptr);
            if (window) {
                hookState = this;
                const auto hook = SetWindowsHookExW(WH_GETMESSAGE, keyboard, nullptr, GetCurrentThreadId());
                MSG message{};
                while (GetMessageW(&message, nullptr, 0, 0) > 0) {
                    TranslateMessage(&message); DispatchMessageW(&message);
                }
                if (hotkeyId) UnregisterHotKey(window, hotkeyId);
                if (hook) UnhookWindowsHookEx(hook);
                hookState = nullptr;
                DestroyWindow(window);
            }
            CoUninitialize();
        });
        if (!result.get()) { thread.join(); throw std::runtime_error("无法初始化 Windows 隐私服务"); }
    }
    ~State() { shutdown(); }
    static LRESULT CALLBACK keyboard(int code, WPARAM wparam, LPARAM lparam) {
        auto* self = hookState;
        if (code == HC_ACTION && wparam == PM_REMOVE && self && self->dialog && self->localEnabled) {
            auto* message = reinterpret_cast<MSG*>(lparam);
            if ((message->message == WM_KEYDOWN || message->message == WM_SYSKEYDOWN) && message->wParam == self->localKey) {
                UINT modifiers = 0;
                if (GetKeyState(VK_CONTROL) & 0x8000) modifiers |= MOD_CONTROL;
                if (GetKeyState(VK_MENU) & 0x8000) modifiers |= MOD_ALT;
                if (GetKeyState(VK_SHIFT) & 0x8000) modifiers |= MOD_SHIFT;
                if (modifiers == self->localModifiers && !(GetKeyState(VK_LWIN) & 0x8000) && !(GetKeyState(VK_RWIN) & 0x8000)) {
                    if (!(message->lParam & (1L << 30))) PostMessageW(self->window, localBoss, 0, 0);
                    message->message = WM_NULL;
                }
            }
        }
        return CallNextHookEx(nullptr, code, wparam, lparam);
    }
    void shutdown() {
        { std::lock_guard lock(mutex); if (stopped) return; stopped = true; }
        PostMessageW(window, stopService, 0, 0);
        if (thread.joinable()) thread.join();
    }
    static LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
        auto* self = reinterpret_cast<State*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<State*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(hwnd, message, wparam, lparam);
        if (message == stopService) {
            if (self->dialog) self->dialog->Close(HRESULT_FROM_WIN32(ERROR_CANCELLED));
            PostQuitMessage(0); return 0;
        }
        if (message == WM_HOTKEY || message == localBoss) {
            // 模态文件选择期间也接收热键；先关闭对话框和隐藏窗口，再通知前端静音。
            try { self->hide(); self->bossKey(); } catch (...) { /* 通道关闭时由宿主生命周期收尾。 */ }
            return 0;
        }
        if (message == runTask) {
            std::function<void()> task;
            { std::lock_guard lock(self->mutex); if (!self->tasks.empty() && !self->stopped) { task = std::move(self->tasks.front()); self->tasks.pop_front(); } }
            if (task) task();
            return 0;
        }
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    void hide(bool hideMain = true) {
        if (dialog) dialog->Close(HRESULT_FROM_WIN32(ERROR_CANCELLED));
        std::set<DWORD> descendants{hostPid};
        std::vector<std::pair<DWORD,DWORD>> processes;
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
            if (Process32FirstW(snapshot, &entry)) do { processes.emplace_back(entry.th32ProcessID, entry.th32ParentProcessID); } while (Process32NextW(snapshot, &entry));
            CloseHandle(snapshot);
        }
        for (int depth = 0; depth < 8; ++depth) {
            bool added = false;
            for (const auto& [pid,parent] : processes) if (descendants.contains(parent)) added |= descendants.insert(pid).second;
            if (!added) break;
        }
        // 只处理本宿主及其同一可执行文件的播放器后代，不接管外部播放器。
        std::set<DWORD> hosts;
        if (hideMain) hosts.insert(hostPid);
        for (auto pid : descendants) if (pid != hostPid && !hostPath.empty() && processPath(pid) == hostPath) hosts.insert(pid);
        EnumWindows([](HWND hwnd, LPARAM data) -> BOOL {
            DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
            if (reinterpret_cast<std::set<DWORD>*>(data)->contains(pid)) ShowWindowAsync(hwnd, SW_HIDE);
            return TRUE;
        }, reinterpret_cast<LPARAM>(&hosts));
    }
    Json hotkey(const Json& params) {
        const auto local = params.at("localKey").get<std::string>();
        const auto localMods = params.at("localModifiers").get<UINT>();
        UINT localCode = 0;
        if (local.size() == 1 && localMods && ((local[0] >= 'A' && local[0] <= 'Z') || (local[0] >= '0' && local[0] <= '9'))) localCode = local[0];
        for (int n = 1; n <= 11; ++n) if (local == "F" + std::to_string(n)) localCode = VK_F1 + n - 1;
        if (!localCode || (localMods != 0 && localMods != MOD_CONTROL && localMods != MOD_ALT && localMods != MOD_SHIFT)) throw std::runtime_error("应用内快捷键无效");
        const auto applyLocal = [&] { localKey = localCode; localModifiers = localMods; localEnabled = params.at("localEnabled").get<bool>(); };
        if (!params.at("enabled").get<bool>()) {
            if (hotkeyId) UnregisterHotKey(window, hotkeyId);
            hotkeyId = 0; applyLocal(); return Json::object();
        }
        const auto key = params.at("key").get<std::string>();
        const auto modifiers = params.at("modifiers").get<UINT>();
        if (modifiers != 0 && modifiers != MOD_ALT && modifiers != MOD_CONTROL && modifiers != MOD_SHIFT) throw std::runtime_error("快捷键最多两个按键");
        UINT code = 0;
        if (key.size() == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9')) && modifiers) code = key[0];
        for (int n = 1; n <= 11; ++n) if (key == "F" + std::to_string(n)) code = VK_F1 + n - 1;
        if (!code) throw std::runtime_error("全局快捷键无效");
        if (hotkeyId && code == activeKey && modifiers == activeModifiers) { applyLocal(); return Json::object(); }
        const int next = hotkeyId == 1 ? 2 : 1;
        if (!RegisterHotKey(window, next, modifiers | MOD_NOREPEAT, code)) throw std::runtime_error("全局快捷键已被系统或其他程序占用，请选择其他按键");
        if (hotkeyId) UnregisterHotKey(window, hotkeyId);
        hotkeyId = next; activeKey = code; activeModifiers = modifiers;
        applyLocal();
        return Json::object();
    }
    Json pick(const std::string& id, const Json& params) {
        if (dialog) throw std::runtime_error("已有文件选择窗口，请先完成或取消");
        check(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)));
        struct Reset { ComPtr<IFileOpenDialog>& value; ~Reset() { value.Reset(); } } reset{dialog};
        dialogRequestId = id;
        DWORD flags = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR;
        if (params.value("protectRecentFiles", true)) flags |= FOS_DONTADDTORECENT;
        const bool folder = params.value("folder", false);
        flags |= folder ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST;
        if (!folder && params.value("multiSelections", false)) flags |= FOS_ALLOWMULTISELECT;
        check(dialog->SetOptions(flags));
        const auto title = wide(params.value("title", "选择文件"), 300);
        check(dialog->SetTitle(title.c_str()));
        const auto path = wide(params.value("defaultPath", ""));
        if (!path.empty()) {
            ComPtr<IShellItem> item;
            if (SUCCEEDED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item)))) dialog->SetFolder(item.Get());
        }
        std::vector<std::pair<std::wstring,std::wstring>> filterText;
        const auto filters = params.value("filters", Json::array());
        if (!filters.is_array() || filters.size() > 20) throw std::runtime_error("文件筛选条件无效");
        for (const auto& filter : filters) {
            const auto extensions = filter.at("extensions");
            if (!extensions.is_array() || extensions.size() > 20) throw std::runtime_error("文件筛选条件无效");
            std::wstring pattern;
            for (const auto& extension : extensions) {
                const auto text = extension.get<std::string>();
                if (text.empty() || text.size() > 20 || text.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*") != std::string::npos) throw std::runtime_error("文件扩展名无效");
                if (!pattern.empty()) pattern += L';';
                pattern += L"*." + wide(text);
            }
            if (!pattern.empty()) filterText.emplace_back(wide(filter.at("name").get<std::string>(), 200), pattern);
        }
        std::vector<COMDLG_FILTERSPEC> specs;
        for (const auto& [name,pattern] : filterText) specs.push_back({name.c_str(), pattern.c_str()});
        if (!folder && !specs.empty()) check(dialog->SetFileTypes(static_cast<UINT>(specs.size()), specs.data()));
        struct Owner { DWORD pid; HWND handle; } owner{hostPid,nullptr};
        EnumWindows([](HWND hwnd, LPARAM data) -> BOOL {
            auto& value = *reinterpret_cast<Owner*>(data); DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
            if (pid == value.pid && IsWindowVisible(hwnd) && !GetWindow(hwnd, GW_OWNER)) { value.handle = hwnd; return FALSE; }
            return TRUE;
        }, reinterpret_cast<LPARAM>(&owner));
        const auto shown = dialog->Show(owner.handle);
        if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return Json::array();
        check(shown);
        ComPtr<IShellItemArray> items; check(dialog->GetResults(&items));
        DWORD count = 0; check(items->GetCount(&count));
        if (count > 1000) throw std::runtime_error("选择文件过多，请分批处理");
        Json result = Json::array();
        for (DWORD i = 0; i < count; ++i) {
            ComPtr<IShellItem> item; check(items->GetItemAt(i, &item));
            PWSTR name = nullptr; check(item->GetDisplayName(SIGDN_FILESYSPATH, &name));
            try { result.push_back(utf8(name)); } catch (...) { CoTaskMemFree(name); throw; }
            CoTaskMemFree(name);
        }
        return result;
    }
    Json openExternal(const Json& params) {
        const auto source = wide(params.at("source").get<std::string>());
        auto executable = wide(params.value("path", ""));
        if (source.empty()) throw std::runtime_error("播放路径无效");
        if (executable.empty()) {
            auto association = std::filesystem::path(source).extension().wstring();
            if (source.starts_with(L"https://")) association = L"https";
            else if (source.starts_with(L"http://")) association = L"http";
            if (association.empty()) throw std::runtime_error("请在播放设置中指定外部播放器");
            DWORD length = 32768; executable.resize(length);
            const auto result = AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, association.c_str(), L"open", executable.data(), &length);
            if (result != S_OK || !length) throw std::runtime_error("无法安全启动系统关联，请指定外部播放器或使用内置播放器");
            executable.resize(length - 1);
        }
        if (!std::filesystem::path(executable).is_absolute() || _wcsicmp(std::filesystem::path(executable).extension().c_str(), L".exe") != 0) throw std::runtime_error("请指定有效的外部播放器 EXE");
        auto command = quote(executable) + L" " + quote(source);
        if (command.size() >= 32767) throw std::runtime_error("播放地址过长，请使用内置播放器");
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
        if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) throw std::runtime_error("无法启动外部播放器，请重新选择播放器");
        CloseHandle(process.hThread); CloseHandle(process.hProcess);
        return Json::object();
    }
};
Privacy::Privacy(unsigned long pid, std::function<void()> bossKey): state_(std::make_unique<State>(pid, std::move(bossKey))) {}
Privacy::~Privacy() = default;
void Privacy::shutdown() { state_->shutdown(); }
void Privacy::request(const std::string& id, const std::string& method, const Json& params, Service::Reply reply) {
    if (!params.is_object() || (method != "privacy.hotkey" && method != "privacy.pick" && method != "privacy.cancelPick" && method != "privacy.hide" && method != "privacy.openExternal")) throw std::runtime_error("隐私服务请求无效");
    std::lock_guard lock(state_->mutex);
    if (state_->stopped || state_->tasks.size() >= 8) throw std::runtime_error("隐私服务忙，请稍后重试");
    state_->tasks.push_back([this,id,method,params,reply = std::move(reply)] {
        Json response{{"requestId",id}};
        try {
            if (method == "privacy.hotkey") response["result"] = state_->hotkey(params);
            else if (method == "privacy.pick") response["result"] = state_->pick(id, params);
            else if (method == "privacy.cancelPick") {
                if (state_->dialog && state_->dialogRequestId == params.value("requestId", "")) state_->dialog->Close(HRESULT_FROM_WIN32(ERROR_CANCELLED));
                response["result"] = Json::object();
            }
            else if (method == "privacy.openExternal") response["result"] = state_->openExternal(params);
            else { state_->hide(params.value("hideMain", true)); response["result"] = Json::object(); }
            response["ok"] = true;
        } catch (const std::exception& error) { response["ok"] = false; response["error"] = error.what(); }
        reply(response);
    });
    if (!PostMessageW(state_->window, runTask, 0, 0)) { state_->tasks.pop_back(); throw std::runtime_error("隐私服务不可用"); }
}
}
