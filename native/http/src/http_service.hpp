#pragma once
#include <functional>
#include <memory>
#include <string>
#include <nlohmann/json.hpp>

namespace javm::http {
// 只负责有界字节传输和连接生命周期；业务解析、缓存策略及队列在 TypeScript。
class Service {
public:
    using Json = nlohmann::json;
    using Reply = std::function<bool(const Json&)>;
    Service();
    ~Service();
    Service(const Service&) = delete;
    Service& operator=(const Service&) = delete;
    void request(const std::string& requestId, const Json& params, Reply reply);
    void cancel(const std::string& requestId, const std::string& id, Reply reply);
    void shutdown();
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
