#pragma once
#include <functional>
#include <memory>
#include <string>
#include <nlohmann/json.hpp>

namespace javm::platform {
// 仅通过官方 Extension 分发；阻塞的系统服务在一个有界后台队列中执行。
class Service {
public:
    using Json = nlohmann::json;
    using Reply = std::function<bool(const Json&)>;
    Service();
    ~Service();
    Service(const Service&) = delete;
    Service& operator=(const Service&) = delete;
    void request(const std::string& requestId, const std::string& method, const Json& params, Reply reply);
    void shutdown();
private:
    struct State;
    std::unique_ptr<State> state_;
};
unsigned loopbackPort();
}
