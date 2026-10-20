#include "protocol.hpp"
#include <CoreServices/CoreServices.h>
#include <filesystem>
#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

namespace javm::platform {
namespace {
struct Url { CFURLRef value = nullptr; ~Url() { if(value) CFRelease(value); } };
std::string currentApplication() {
    Url request{CFURLCreateWithString(nullptr, CFSTR("javm://application/status"), nullptr)};
    CFErrorRef error = nullptr;
    Url app{LSCopyDefaultApplicationURLForURL(request.value, kLSRolesAll, &error)};
    if(error) CFRelease(error);
    if(!app.value) return {};
    UInt8 buffer[32768];
    if(!CFURLGetFileSystemRepresentation(app.value, true, buffer, sizeof(buffer))) throw std::runtime_error("无法读取当前链接关联");
    return std::filesystem::weakly_canonical(reinterpret_cast<const char*>(buffer)).string();
}
}
nlohmann::json protocol(const nlohmann::json& params) {
    const auto operation = params.at("operation").get<std::string>();
    const auto entry = params.at("entry").get<std::string>();
    if(operation != "status" && operation != "register" && operation != "remove") throw std::runtime_error("链接操作无效");
    const auto file = std::filesystem::path(entry);
    const auto bundle = file.parent_path().parent_path().parent_path();
    if(entry.size() > 32768 || entry.find('\0') != std::string::npos || !file.is_absolute() ||
        file.filename() != "JAVM" || file.parent_path().filename() != "MacOS" || bundle.extension() != ".app" ||
        !std::filesystem::is_regular_file(bundle / "Contents/Info.plist"))
        throw std::runtime_error("请将完整的 JAVM.app 放入 Applications 后设置链接关联");
    auto current = currentApplication();
    const auto expected = std::filesystem::canonical(bundle).string();
    const auto isCurrent = [&] {
        std::error_code error;
        return !current.empty() && std::filesystem::equivalent(current, bundle, error) && !error;
    };
    if(operation == "remove") throw std::runtime_error("macOS 管理 APP 的链接声明，请在其他应用中更改默认程序，或移除此 APP");
    if(operation == "register" && !isCurrent()) {
        if(!current.empty() && params.value("expected", "") != current) throw std::runtime_error("链接关联已变化，请刷新后重新确认");
        Url url{CFURLCreateFromFileSystemRepresentation(nullptr, reinterpret_cast<const UInt8*>(expected.data()), expected.size(), true)};
        if(!url.value || LSRegisterURL(url.value, true) != noErr ||
            LSSetDefaultHandlerForURLScheme(CFSTR("javm"), CFSTR("net.ddmoyu.javm")) != noErr)
            throw std::runtime_error("无法设置 macOS 链接关联，请在 Finder 中打开此 APP 后重试");
        // LaunchServices updates its registration database asynchronously. This
        // bounded wait runs on the platform service worker, never the UI thread.
        for(int attempt = 0; attempt < 20; ++attempt) {
            current = currentApplication();
            if(isCurrent()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        if(!isCurrent()) throw std::runtime_error("系统仍关联到另一份 APP，请在 Finder 中打开此 APP 后重试");
    }
    return {{"state", current.empty() ? "missing" : isCurrent() ? "current" : "other"},
        {"command", current}, {"entry", entry}, {"canRemove", false}};
}
}
