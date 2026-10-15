#pragma once
#include <atomic>
#include <thread>
#include <utility>

namespace javm {
// macOS 13 的系统 libc++ 不提供 jthread。任务合作检查停止标志，析构总会等待收尾。
class CancellableThread {
    std::atomic_bool stopping_ = false;
    std::thread thread_;
public:
    template<class Task> explicit CancellableThread(Task task): thread_([this, task = std::move(task)]() mutable { task(stopping_); }) {}
    CancellableThread(const CancellableThread&) = delete;
    CancellableThread& operator=(const CancellableThread&) = delete;
    ~CancellableThread() { stopping_ = true; if (thread_.joinable()) thread_.join(); }
};
}
