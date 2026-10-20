#pragma once
#include <memory>
#include <mutex>

namespace javm {
// 系统 libc++ 尚未提供 atomic<shared_ptr> 的平台也保持相同的发布 / 生命周期语义。
template<class T> class SharedSlot {
    mutable std::mutex mutex_;
    std::shared_ptr<T> value_;
public:
    std::shared_ptr<T> load() const { std::lock_guard lock(mutex_); return value_; }
    void store(std::shared_ptr<T> value) { std::lock_guard lock(mutex_); value_ = std::move(value); }
};
}
