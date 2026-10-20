#pragma once
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace media {
// 有界队列：生产者背压，固定工作线程；任务负责捕获自己的业务异常。
class WorkQueue {
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::function<void()>> jobs_;
    std::vector<std::thread> workers_;
    size_t capacity_;
    bool closed_ = false;
public:
    WorkQueue(unsigned count, size_t capacity): capacity_(capacity) {
        try {
            for (unsigned i = 0; i < count; ++i) workers_.emplace_back([this] {
                for (;;) {
                    std::function<void()> task;
                    {
                        std::unique_lock lock(mutex_);
                        changed_.wait(lock, [this] { return closed_ || !jobs_.empty(); });
                        if (jobs_.empty()) return;
                        task = std::move(jobs_.front()); jobs_.pop_front();
                    }
                    changed_.notify_all();
                    task();
                }
            });
        } catch (...) { close(true); join(); throw; }
    }
    ~WorkQueue() { close(true); join(); }
    WorkQueue(const WorkQueue&) = delete;
    WorkQueue& operator=(const WorkQueue&) = delete;
    bool trySubmit(std::function<void()> task) {
        std::lock_guard lock(mutex_);
        if (closed_ || jobs_.size() >= capacity_) return false;
        jobs_.push_back(std::move(task)); changed_.notify_all(); return true;
    }
    bool submit(std::function<void()> task, const std::atomic_bool& cancelled) {
        std::unique_lock lock(mutex_);
        while (!closed_ && !cancelled && jobs_.size() >= capacity_)
            changed_.wait_for(lock, std::chrono::milliseconds(25));
        if (closed_ || cancelled) return false;
        jobs_.push_back(std::move(task)); changed_.notify_all(); return true;
    }
    void close(bool discard = false) {
        std::lock_guard lock(mutex_);
        closed_ = true;
        if (discard) jobs_.clear();
        changed_.notify_all();
    }
    void join() { for (auto& thread: workers_) if (thread.joinable()) thread.join(); }
};
}
