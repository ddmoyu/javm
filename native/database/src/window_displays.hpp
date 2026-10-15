#pragma once
#ifdef _WIN32
#include <windows.h>
#include <nlohmann/json.hpp>
#include <exception>
#include <stdexcept>
#include <vector>

namespace desktop {
// 与未启用 useLogicalPixels 的 Neutralino 窗口使用同一物理像素坐标系。
// 只切换当前请求线程，退出时恢复，不改变宿主或其他线程的 DPI 设置。
class DisplayDpiContext {
    DPI_AWARENESS_CONTEXT previous_;
public:
    DisplayDpiContext(): previous_(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        if (!previous_) throw std::runtime_error("无法读取物理像素显示区域");
    }
    ~DisplayDpiContext() { SetThreadDpiAwarenessContext(previous_); }
    DisplayDpiContext(const DisplayDpiContext&) = delete;
    DisplayDpiContext& operator=(const DisplayDpiContext&) = delete;
};

inline nlohmann::json windowDisplays() {
    const DisplayDpiContext dpi;
    struct Enumeration {
        std::vector<MONITORINFO> monitors;
        std::exception_ptr error;
    } enumeration;
    const auto success = EnumDisplayMonitors(nullptr, nullptr,
        [](HMONITOR monitor, HDC, LPRECT, LPARAM data) noexcept -> BOOL {
            auto& result = *reinterpret_cast<Enumeration*>(data);
            try {
                MONITORINFO info{};
                info.cbSize = sizeof(info);
                if (!GetMonitorInfoW(monitor, &info)) throw std::runtime_error("无法读取显示器工作区域");
                result.monitors.push_back(info);
                return TRUE;
            } catch (...) {
                result.error = std::current_exception();
                return FALSE;
            }
        }, reinterpret_cast<LPARAM>(&enumeration));
    if (enumeration.error) std::rethrow_exception(enumeration.error);
    if (!success || enumeration.monitors.empty()) throw std::runtime_error("无法枚举显示器");
    const auto rect = [](const RECT& value) {
        return nlohmann::json{{"x", value.left}, {"y", value.top},
            {"width", value.right - value.left}, {"height", value.bottom - value.top}};
    };
    auto result = nlohmann::json::array();
    for (const auto& monitor : enumeration.monitors) {
        result.push_back({{"primary", (monitor.dwFlags & MONITORINFOF_PRIMARY) != 0},
            {"bounds", rect(monitor.rcMonitor)}, {"workArea", rect(monitor.rcWork)}});
    }
    return result;
}
}
#endif
