#pragma once
#include "service.hpp"

namespace javm::platform {
class Privacy {
public:
    Privacy(unsigned long hostPid, std::function<void()> bossKey);
    ~Privacy();
    Privacy(const Privacy&) = delete;
    Privacy& operator=(const Privacy&) = delete;
    void request(const std::string& id, const std::string& method, const Service::Json& params, Service::Reply reply);
    void shutdown();
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
