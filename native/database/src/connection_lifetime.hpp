#pragma once
#include <chrono>
#include <cstdlib>
#include <functional>
#include <thread>

namespace javm::extension {
// curl 后端用 WebSocket Ping/Pong 检测宿主，继承套接字的进程不能无限延长会话。
// 断连后正常退出优先；只有清理停滞时才终止自身，操作系统会释放文件锁。
class ConnectionLifetime {
    std::jthread watcher_;
public:
    explicit ConnectionLifetime(std::function<bool()> connected): watcher_([connected = std::move(connected)](std::stop_token stop) {
        using namespace std::chrono_literals;
        while (!stop.stop_requested() && connected()) std::this_thread::sleep_for(100ms);
        for (int i = 0; i < 20 && !stop.stop_requested(); ++i) std::this_thread::sleep_for(100ms);
        if (!stop.stop_requested()) std::_Exit(EXIT_FAILURE);
    }) {}
};
} // namespace javm::extension
