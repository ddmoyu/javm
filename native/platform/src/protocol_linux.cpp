#include "protocol.hpp"
#include <gio/gdesktopappinfo.h>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <unistd.h>

namespace javm::platform {
namespace {
struct App { GAppInfo* value = nullptr; ~App() { if(value) g_object_unref(value); } };
std::string command(GAppInfo* app) {
    const auto* value = app ? g_app_info_get_commandline(app) : nullptr;
    return value ? value : "";
}
void check(bool success, GError* error) {
    if(error) g_error_free(error);
    if(!success) throw std::runtime_error("无法修改当前用户的链接关联，请检查桌面环境和目录权限");
}
}
nlohmann::json protocol(const nlohmann::json& params) {
    const auto operation = params.at("operation").get<std::string>();
    const auto requestedEntry = params.at("entry").get<std::string>();
    // AppImage mounts/extracts its payload in a temporary directory. Persist the
    // original image path supplied by its runtime, never that transient launcher.
    const auto* appImage = std::getenv("APPIMAGE");
    const auto entry = appImage && *appImage ? std::string(appImage) : requestedEntry;
    if(operation != "status" && operation != "register" && operation != "remove") throw std::runtime_error("链接操作无效");
    if(requestedEntry.size() > 32768 || requestedEntry.find('\0') != std::string::npos ||
       !std::filesystem::path(requestedEntry).is_absolute() || std::filesystem::path(requestedEntry).filename() != "JAVM" ||
       access(requestedEntry.c_str(), X_OK) != 0 || entry.size() > 32768 || entry.find_first_of("\r\n") != std::string::npos ||
       !std::filesystem::path(entry).is_absolute() || access(entry.c_str(), X_OK) != 0)
        throw std::runtime_error("请在完整的 JAVM 安装包或便携包中设置链接关联");
    App current{g_app_info_get_default_for_uri_scheme("javm")};
    const auto existing = command(current.value);
    auto isCurrent = [&](GAppInfo* app) {
        const auto* executable = app ? g_app_info_get_executable(app) : nullptr;
        return executable && entry == executable;
    };
    if(operation == "register") {
        if(current.value && !isCurrent(current.value) && params.value("expected", "") != existing)
            throw std::runtime_error("链接关联已变化，请刷新后重新确认");
        if(!isCurrent(current.value)) {
            // GIO 生成当前用户的 desktop entry；%% 防止文件名被解释为字段代码。
            std::string escaped;
            for(char c : entry) { escaped += c; if(c == '%') escaped += '%'; }
            auto* quoted = g_shell_quote(escaped.c_str());
            GError* error = nullptr;
            App app{g_app_info_create_from_commandline(quoted, "JAVM", G_APP_INFO_CREATE_SUPPORTS_URIS, &error)};
            g_free(quoted); check(app.value != nullptr, error);
            error = nullptr;
            const bool saved = g_app_info_set_as_default_for_type(app.value, "x-scheme-handler/javm", &error);
            check(saved, error);
        }
    } else if(operation == "remove" && current.value) {
        if(!isCurrent(current.value)) throw std::runtime_error("链接关联属于另一份程序，未作修改");
        if(!g_app_info_can_delete(current.value)) throw std::runtime_error("该关联来自系统安装，请在系统默认应用设置中更改或卸载该程序");
        check(g_app_info_delete(current.value), nullptr);
    }
    App final{g_app_info_get_default_for_uri_scheme("javm")};
    return {{"state", !final.value ? "missing" : isCurrent(final.value) ? "current" : "other"},
        {"command", command(final.value)}, {"entry", entry}};
}
}
