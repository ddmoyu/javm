#pragma once
#include <chrono>
#include <atomic>
#include <cstdlib>
#include <functional>
#include <thread>

namespace javm::extension {
// curl 后端用 WebSocket Ping/Pong 检测宿主，继承套接字的进程不能无限延长会话。
// 断连后正常退出优先；只有清理停滞时才终止自身，操作系统会释放文件锁。
class ConnectionLifetime {
    std::atomic_bool stopping_ = false;
    std::thread watcher_;
public:
    explicit ConnectionLifetime(std::function<bool()> connected): watcher_([this, connected = std::move(connected)] {
        using namespace std::chrono_literals;
        while (!stopping_ && connected()) std::this_thread::sleep_for(100ms);
        for (int i = 0; i < 20 && !stopping_; ++i) std::this_thread::sleep_for(100ms);
        if (!stopping_) std::_Exit(EXIT_FAILURE);
    }) {}
    ~ConnectionLifetime() { stopping_ = true; if (watcher_.joinable()) watcher_.join(); }
};
} // namespace javm::extension
