#include "service.hpp"
#include "credentials.hpp"
#include "protocol.hpp"
#include "../../media/src/work_queue.hpp"
#include <atomic>
#include <stdexcept>

namespace javm::platform {
struct Service::State {
    Credentials credentials;
    media::WorkQueue queue{1, 8};
    std::atomic_bool stopped = false;
    void shutdown() {
        if (stopped.exchange(true)) return;
        queue.close(true);
        credentials.cancel();
        queue.join();
    }
    ~State() { shutdown(); }
};
Service::Service(): state_(std::make_unique<State>()) {}
Service::~Service() = default;
void Service::shutdown() { state_->shutdown(); }
void Service::request(const std::string& requestId, const std::string& method, const Json& params, Reply reply) {
    if (method != "platform.protocol" && method != "platform.loopbackPort" && method != "platform.credentials.read" && method != "platform.credentials.write")
        throw std::runtime_error("未知的系统服务请求");
    if (!params.is_object()) throw std::runtime_error("系统服务参数无效");
    std::string key, value;
    if (method.starts_with("platform.credentials.")) {
        key = params.value("key", "");
        if (key != "javm-ai-settings-v1" && key != "javm-metatube-settings-v1")
            throw std::runtime_error("不支持的凭据配置");
        if (method.ends_with(".write")) {
            value = params.at("value").get<std::string>();
            if (value.size() > 80000 || value.find('\0') != std::string::npos || !Json::accept(value))
                throw std::runtime_error("服务配置格式无效或内容过大");
        }
    }
    const auto submitted = std::chrono::steady_clock::now();
    if (!state_->queue.trySubmit([this, requestId, method, key, value, params, submitted, reply = std::move(reply)] {
        if (state_->stopped) return;
        Json response{{"requestId", requestId}};
        try {
            if (std::chrono::steady_clock::now() - submitted > std::chrono::seconds(5))
                throw std::runtime_error("系统服务等待超时，请稍后重试");
            if (method == "platform.protocol") response["result"] = protocol(params);
            else if (method == "platform.loopbackPort") response["result"] = {{"port", loopbackPort()}};
            else if (method.ends_with(".read")) {
                const auto found = state_->credentials.read(key);
                response["result"] = found ? Json(*found) : Json(nullptr);
            } else { state_->credentials.write(key, value); response["result"] = Json::object(); }
            response["ok"] = true;
        } catch (const std::exception& error) {
            response["ok"] = false;
            response["error"] = error.what();
        }
        if (!state_->stopped) reply(response);
    })) throw std::runtime_error("系统服务正在处理其他请求，请稍后重试");
}
}
