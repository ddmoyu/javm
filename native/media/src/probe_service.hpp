#pragma once
#include "common.hpp"
#include "work_queue.hpp"
#include <algorithm>
#include <map>
#include <memory>

namespace media {
// 官方 Extension 内的独立有界队列，不占用数据库接收线程或扫描队列。
class ProbeService {
    std::mutex mutex_;
    std::map<std::string, std::shared_ptr<std::atomic_bool>> active_;
    WorkQueue requests_{std::clamp(std::max(1u, std::thread::hardware_concurrency()) - 1, 1u, 2u), 8};
public:
    ~ProbeService() { shutdown(); }
    void submit(const std::string& requestId, const Json& params, std::function<void(const Json&)> reply) {
        const auto id = params.at("id").get<std::string>();
        const auto text = params.at("path").get<std::string>();
        if (id.empty() || id.size() > 100) throw std::runtime_error("媒体探测任务无效");
        if (text.empty() || text.size() > 32768 || text.find('\0') != std::string::npos)
            throw std::runtime_error("媒体路径无效");
        const fs::path path(wide(text));
        if (!path.is_absolute()) throw std::runtime_error("媒体路径必须为绝对路径");
        const auto cancelled = std::make_shared<std::atomic_bool>(false);
        std::lock_guard lock(mutex_);
        if (!active_.emplace(id, cancelled).second) throw std::runtime_error("媒体探测任务重复");
        if (!requests_.trySubmit([this, id, path, requestId, cancelled, reply] {
            Json response{{"requestId", requestId}};
            try {
                response["result"] = probe(path, *cancelled);
                if (*cancelled) throw std::runtime_error("媒体探测已取消");
                response["ok"] = true;
            } catch (const std::exception& error) { response["ok"] = false; response["error"] = error.what(); }
            { std::lock_guard guard(mutex_); active_.erase(id); }
            reply(response);
        })) {
            active_.erase(id);
            throw std::runtime_error("媒体探测队列已满，请稍后重试");
        }
    }
    void cancel(const std::string& id) {
        std::lock_guard lock(mutex_);
        if (const auto found = active_.find(id); found != active_.end()) *found->second = true;
    }
    void shutdown() {
        { std::lock_guard lock(mutex_); for (const auto& [id, cancelled]: active_) *cancelled = true; }
        requests_.close(true);
        requests_.join();
    }
};
}
