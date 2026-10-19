#include "http_service.hpp"
#include "../../common/utf8.hpp"
#include <curl/curl.h>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <deque>
#include <fstream>
#include <filesystem>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace javm::http {
using Json = Service::Json;
using Clock = std::chrono::steady_clock;
namespace {
std::string lower(std::string value) {
    for (auto& ch : value) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}
bool hasControl(const std::string& value) {
    return std::any_of(value.begin(), value.end(), [](unsigned char ch) { return ch < 32 || ch == 127; });
}
struct Url {
    CURLU* value = curl_url();
    ~Url() { curl_url_cleanup(value); }
    std::string part(CURLUPart part) const {
        char* text = nullptr;
        if (curl_url_get(value, part, &text, 0) != CURLUE_OK) return {};
        std::string result(text);
        curl_free(text);
        return result;
    }
};
std::string validateUrl(const std::string& value, bool proxy = false) {
    Url url;
    if (value.empty() || value.size() > 8192 || hasControl(value) || !url.value ||
        curl_url_set(url.value, CURLUPART_URL, value.c_str(), CURLU_NON_SUPPORT_SCHEME) != CURLUE_OK)
        throw std::runtime_error("HTTP 地址无效");
    const auto scheme = lower(url.part(CURLUPART_SCHEME));
    if (scheme != "http" && scheme != "https" && !(proxy && (scheme == "socks5" || scheme == "socks5h")))
        throw std::runtime_error("HTTP 协议无效");
    if (!proxy && (!url.part(CURLUPART_USER).empty() || !url.part(CURLUPART_PASSWORD).empty()))
        throw std::runtime_error("HTTP 地址不能包含凭据");
    return scheme + "://" + lower(url.part(CURLUPART_HOST)) + ":" + url.part(CURLUPART_PORT);
}
void check(CURLcode code) { if (code != CURLE_OK) throw std::runtime_error("无法配置 HTTP 传输"); }
struct Transfer {
    std::string requestId, id, url, proxy, method, body, origin;
    std::filesystem::path output;
    Json requestHeaders, headers = Json::object();
    Service::Reply reply;
    CURL* easy = nullptr;
    curl_slist* headerList = nullptr;
    std::ofstream file;
    size_t bytes = 0, headerBytes = 0, maxBytes = 0;
    bool limited = false, setCookie = false, ambiguousHeaders = false, invalidHeaders = false;
    long timeout = 0, connectTimeout = 0, redirects = 0;
    Clock::time_point deadline;
    ~Transfer() {
        if (easy) curl_easy_cleanup(easy);
        curl_slist_free_all(headerList);
    }
    static size_t write(char* data, size_t size, size_t count, void* user) noexcept {
        auto& self = *static_cast<Transfer*>(user);
        const auto length = size * count;
        if (length > self.maxBytes - self.bytes) { self.limited = true; return 0; }
        self.file.write(data, static_cast<std::streamsize>(length));
        if (!self.file) return 0;
        self.bytes += length;
        return length;
    }
    static size_t header(char* data, size_t size, size_t count, void* user) noexcept {
        auto& self = *static_cast<Transfer*>(user);
        const auto length = size * count;
        if (length > 65536 - self.headerBytes) { self.limited = true; return 0; }
        self.headerBytes += length;
        try {
            std::string line(data, length);
            if (line.starts_with("HTTP/")) { self.headers = Json::object(); self.setCookie = false; self.ambiguousHeaders = false; return length; }
            const auto colon = line.find(':');
            if (colon == std::string::npos) return length;
            const auto key = lower(line.substr(0, colon));
            if (key == "set-cookie") self.setCookie = true;
            static const std::set<std::string> allowed{"content-type","content-length","content-range","content-encoding","location","cache-control","expires","age","etag","last-modified","vary","retry-after","x-ratelimit-remaining","x-ratelimit-reset","cf-mitigated"};
            if (!allowed.contains(key)) return length;
            auto value = line.substr(colon + 1);
            value.erase(0, value.find_first_not_of(" \t"));
            value.erase(value.find_last_not_of(" \t\r\n") + 1);
            // JSON 事件只能携带 UTF-8；拒绝畸形响应头，不能让序列化异常终止扩展线程。
            if (!isValidUtf8(value)) {
                self.invalidHeaders = true;
                return 0;
            }
            if (self.headers.contains(key)) {
                if (key == "location" || key == "content-type" || key == "content-range" || key == "content-length" || key == "content-encoding") self.ambiguousHeaders = true;
                self.headers[key] = self.headers[key].get<std::string>() + ", " + value;
            }
            else self.headers[key] = value;
            return length;
        } catch (...) { return 0; }
    }
    void start() {
        easy = curl_easy_init();
        if (!easy) throw std::runtime_error("无法创建 HTTP 传输");
        file.open(output, std::ios::binary | std::ios::trunc);
        if (!file) throw std::runtime_error("HTTP 临时文件写入失败");
        for (const auto& [name, value] : requestHeaders.items()) {
            const auto header = name + ": " + value.get<std::string>();
            auto* next = curl_slist_append(headerList, header.c_str());
            if (!next) throw std::runtime_error("HTTP 请求头分配失败");
            headerList = next;
        }
        check(curl_easy_setopt(easy, CURLOPT_URL, url.c_str()));
        check(curl_easy_setopt(easy, CURLOPT_PROTOCOLS_STR, "http,https"));
        check(curl_easy_setopt(easy, CURLOPT_REDIR_PROTOCOLS_STR, "http,https"));
        check(curl_easy_setopt(easy, CURLOPT_PROXY, proxy.c_str()));
        check(curl_easy_setopt(easy, CURLOPT_NOPROXY, proxy.empty() ? "*" : ""));
        check(curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L));
        check(curl_easy_setopt(easy, CURLOPT_FOLLOWLOCATION, redirects ? 1L : 0L));
        check(curl_easy_setopt(easy, CURLOPT_MAXREDIRS, redirects));
        check(curl_easy_setopt(easy, CURLOPT_UNRESTRICTED_AUTH, 0L));
        check(curl_easy_setopt(easy, CURLOPT_SSL_VERIFYPEER, 1L));
        check(curl_easy_setopt(easy, CURLOPT_SSL_VERIFYHOST, 2L));
        check(curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, connectTimeout));
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        check(curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, static_cast<long>(std::max<int64_t>(1, remaining))));
        check(curl_easy_setopt(easy, CURLOPT_MAXFILESIZE_LARGE, static_cast<curl_off_t>(maxBytes)));
        check(curl_easy_setopt(easy, CURLOPT_TCP_KEEPALIVE, 1L));
        check(curl_easy_setopt(easy, CURLOPT_MAXAGE_CONN, 60L));
        check(curl_easy_setopt(easy, CURLOPT_HTTPHEADER, headerList));
        if (method == "HEAD") check(curl_easy_setopt(easy, CURLOPT_NOBODY, 1L));
        else if (method != "GET") {
            check(curl_easy_setopt(easy, CURLOPT_CUSTOMREQUEST, method.c_str()));
            check(curl_easy_setopt(easy, CURLOPT_POSTFIELDS, body.c_str()));
            check(curl_easy_setopt(easy, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(body.size())));
        }
        check(curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, &Transfer::write));
        check(curl_easy_setopt(easy, CURLOPT_WRITEDATA, this));
        check(curl_easy_setopt(easy, CURLOPT_HEADERFUNCTION, &Transfer::header));
        check(curl_easy_setopt(easy, CURLOPT_HEADERDATA, this));
    }
    void finish(CURLcode code) {
        long status = 0, tunnel = 0, connections = 0;
        curl_off_t duration = 0;
        char* effective = nullptr;
        if (easy) {
            curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &status);
            curl_easy_getinfo(easy, CURLINFO_HTTP_CONNECTCODE, &tunnel);
            curl_easy_getinfo(easy, CURLINFO_NUM_CONNECTS, &connections);
            curl_easy_getinfo(easy, CURLINFO_TOTAL_TIME_T, &duration);
            curl_easy_getinfo(easy, CURLINFO_EFFECTIVE_URL, &effective);
        }
        if (file.is_open()) {
            file.close();
            if (!file && code == CURLE_OK) code = CURLE_WRITE_ERROR;
        }
        if (limited) code = CURLE_FILESIZE_EXCEEDED;
        else if (invalidHeaders) code = CURLE_WEIRD_SERVER_REPLY;
        reply(Json{{"requestId",requestId},{"ok",true},{"result",{
            {"status",status},{"exitCode",static_cast<int>(code)},{"bytes",bytes},
            {"headers",headers},{"setCookie",setCookie},{"ambiguousHeaders",ambiguousHeaders},{"effectiveUrl",effective ? effective : url},
            {"connections",connections},{"elapsedMs",duration / 1000},{"tunnelStatus",tunnel}}}});
    }
};
}
struct Service::State {
    struct Cancel { std::string requestId, id; Reply reply; };
    /** 与 TypeScript 队列的网页 4 个加图片 8 个对应。 */
    static constexpr size_t maxActive = 12;
    CURLM* multi = nullptr;
    std::mutex mutex;
    std::deque<std::unique_ptr<Transfer>> queued;
    std::deque<Cancel> cancellations;
    std::set<std::string> ids;
    std::map<CURL*, std::unique_ptr<Transfer>> active;
    bool stopping = false;
    std::thread worker;
    State() {
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) throw std::runtime_error("HTTP 初始化失败");
        multi = curl_multi_init();
        if (!multi) { curl_global_cleanup(); throw std::runtime_error("HTTP 连接池初始化失败"); }
        // 分道限流在 TypeScript 队列中完成（网页每站 2 个、图片每站 6 个）；这里只设总上限。
        curl_multi_setopt(multi, CURLMOPT_MAX_TOTAL_CONNECTIONS, static_cast<long>(maxActive));
        curl_multi_setopt(multi, CURLMOPT_MAX_HOST_CONNECTIONS, 6L);
        curl_multi_setopt(multi, CURLMOPT_MAXCONNECTS, 24L);
        worker = std::thread([this] { run(); });
    }
    ~State() { shutdown(); curl_multi_cleanup(multi); curl_global_cleanup(); }
    void shutdown() {
        { std::lock_guard lock(mutex); stopping = true; curl_multi_wakeup(multi); }
        if (worker.joinable()) worker.join();
    }
    void complete(std::unique_ptr<Transfer> transfer, CURLcode code) {
        { std::lock_guard lock(mutex); ids.erase(transfer->id); }
        transfer->finish(code);
    }
    void run() {
        for (;;) {
            std::deque<std::unique_ptr<Transfer>> start;
            std::deque<Cancel> cancel;
            bool stop;
            {
                std::lock_guard lock(mutex);
                stop = stopping;
                cancel.swap(cancellations);
                if (stop) start.swap(queued);
                else while (!queued.empty() && active.size() + start.size() < maxActive) {
                    start.push_back(std::move(queued.front())); queued.pop_front();
                }
            }
            for (auto& item : start) {
                const bool cancelled = stop || std::any_of(cancel.begin(), cancel.end(), [&](const Cancel& value) { return value.id == item->id; });
                if (cancelled) { complete(std::move(item), CURLE_ABORTED_BY_CALLBACK); continue; }
                if (Clock::now() >= item->deadline) { complete(std::move(item), CURLE_OPERATION_TIMEDOUT); continue; }
                try {
                    item->start();
                    const auto handle = item->easy;
                    // 先分配 map 节点，避免已加入 multi 后容器分配失败留下悬空句柄。
                    const auto inserted = active.try_emplace(handle).first;
                    if (curl_multi_add_handle(multi, handle) != CURLM_OK) {
                        active.erase(inserted);
                        throw std::runtime_error("HTTP 连接池启动失败");
                    }
                    inserted->second = std::move(item);
                } catch (...) { complete(std::move(item), CURLE_FAILED_INIT); }
            }
            for (auto& action : cancel) {
                std::unique_ptr<Transfer> pending;
                {
                    std::lock_guard lock(mutex);
                    const auto found = std::find_if(queued.begin(), queued.end(), [&](const auto& item) { return item->id == action.id; });
                    if (found != queued.end()) { pending = std::move(*found); queued.erase(found); }
                }
                if (pending) complete(std::move(pending), CURLE_ABORTED_BY_CALLBACK);
                for (auto it = active.begin(); it != active.end(); ++it) if (it->second->id == action.id) {
                    curl_multi_remove_handle(multi, it->first);
                    auto transfer = std::move(it->second); active.erase(it);
                    complete(std::move(transfer), CURLE_ABORTED_BY_CALLBACK); break;
                }
                action.reply(Json{{"requestId",action.requestId},{"ok",true},{"result",{{"stopped",true}}}});
            }
            if (stop) {
                for (auto& [handle, transfer] : active) { curl_multi_remove_handle(multi, handle); complete(std::move(transfer), CURLE_ABORTED_BY_CALLBACK); }
                active.clear(); return;
            }
            int running = 0;
            const auto performed = curl_multi_perform(multi, &running);
            if (performed != CURLM_OK) {
                for (auto& [handle, transfer] : active) { curl_multi_remove_handle(multi, handle); complete(std::move(transfer), CURLE_FAILED_INIT); }
                active.clear();
            }
            int left = 0;
            while (const auto* message = curl_multi_info_read(multi, &left)) {
                if (message->msg != CURLMSG_DONE) continue;
                auto found = active.find(message->easy_handle);
                if (found == active.end()) continue;
                const auto code = message->data.result;
                curl_multi_remove_handle(multi, found->first);
                auto transfer = std::move(found->second); active.erase(found);
                complete(std::move(transfer), code);
            }
            curl_multi_poll(multi, nullptr, 0, 250, nullptr);
        }
    }
};
Service::Service() : state_(std::make_unique<State>()) {}
Service::~Service() = default;
void Service::shutdown() { state_->shutdown(); }
void Service::request(const std::string& requestId, const Json& params, Reply reply) {
    auto transfer = std::make_unique<Transfer>();
    transfer->requestId = requestId;
    transfer->id = params.at("id").get<std::string>();
    if (transfer->id.size() != 36 || transfer->id.find_first_not_of("0123456789abcdef-") != std::string::npos) throw std::runtime_error("HTTP 请求编号无效");
    transfer->url = params.at("url").get<std::string>();
    transfer->origin = validateUrl(transfer->url);
    transfer->proxy = params.value("proxy", "");
    if (!transfer->proxy.empty()) validateUrl(transfer->proxy, true);
    transfer->method = params.value("method", "GET");
    if (transfer->method != "GET" && transfer->method != "HEAD" && transfer->method != "POST" && transfer->method != "PUT" && transfer->method != "DELETE" && transfer->method != "PATCH") throw std::runtime_error("HTTP 方法无效");
    transfer->body = params.value("body", "");
    if (transfer->body.size() > 1024 * 1024) throw std::runtime_error("HTTP 请求体过大");
    const auto output = params.at("output").get<std::string>();
    transfer->output = std::filesystem::path(std::u8string(output.begin(), output.end()));
    if (!transfer->output.is_absolute()) throw std::runtime_error("HTTP 临时路径无效");
    transfer->maxBytes = params.at("maxBytes").get<size_t>();
    transfer->timeout = params.at("timeoutMs").get<long>();
    transfer->connectTimeout = params.value("connectTimeoutMs", 5000L);
    transfer->redirects = params.value("maxRedirects", 0L);
    if (!transfer->maxBytes || transfer->maxBytes > 64 * 1024 * 1024 || transfer->timeout < 1 || transfer->timeout > 120000 || transfer->connectTimeout < 1 || transfer->connectTimeout > transfer->timeout || transfer->redirects < 0 || transfer->redirects > 8) throw std::runtime_error("HTTP 限制参数无效");
    transfer->requestHeaders = params.value("headers", Json::object());
    if (!transfer->requestHeaders.is_object() || transfer->requestHeaders.size() > 32) throw std::runtime_error("HTTP 请求头无效");
    size_t headerBytes = 0;
    for (const auto& [name, value] : transfer->requestHeaders.items()) {
        if (name.empty() || name.size() > 100 || name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-.^_`|~") != std::string::npos || !value.is_string()) throw std::runtime_error("HTTP 请求头无效");
        const auto text = value.get<std::string>(); headerBytes += name.size() + text.size();
        if (hasControl(text) || headerBytes > 32768) throw std::runtime_error("HTTP 请求头无效");
    }
    transfer->deadline = Clock::now() + std::chrono::milliseconds(transfer->timeout);
    transfer->reply = std::move(reply);
    std::lock_guard lock(state_->mutex);
    if (state_->stopping || state_->ids.size() >= 64 || state_->ids.contains(transfer->id)) throw std::runtime_error("HTTP 队列已满或已经关闭");
    state_->ids.insert(transfer->id);
    state_->queued.push_back(std::move(transfer));
    curl_multi_wakeup(state_->multi);
}
void Service::cancel(const std::string& requestId, const std::string& id, Reply reply) {
    std::lock_guard lock(state_->mutex);
    if (state_->stopping || state_->cancellations.size() >= 64) throw std::runtime_error("HTTP 取消队列不可用");
    state_->cancellations.push_back({requestId,id,std::move(reply)});
    curl_multi_wakeup(state_->multi);
}
}
