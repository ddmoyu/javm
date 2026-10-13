#include "extension_transport.hpp"
#include <curl/curl.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

namespace javm::extension {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
struct CurlRuntime {
    CurlRuntime() {
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
            throw std::runtime_error("Extension network initialization failed");
    }
    ~CurlRuntime() { curl_global_cleanup(); }
};
class CurlTransport final : public Transport {
    struct Outgoing {
        std::string text;
        std::size_t offset = 0;
        unsigned flags = CURLWS_TEXT;
        bool business = true, complete = false;
        Clock::time_point deadline = Clock::now() + 5s;
    };
    // 先初始化全局库，后创建句柄；析构时顺序相反，工作线程在 close 中先结束。
    CurlRuntime runtime_;
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> easy_{curl_easy_init(), curl_easy_cleanup};
    std::unique_ptr<CURLM, decltype(&curl_multi_cleanup)> poller_{curl_multi_init(), curl_multi_cleanup};
    curl_socket_t socket_ = CURL_SOCKET_BAD;
    std::atomic_bool connected_{false}, stopping_{false};
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::string> incoming_;
    std::deque<std::shared_ptr<Outgoing>> outgoing_;
    std::size_t incomingBytes_ = 0, outgoingBytes_ = 0, outgoingCount_ = 0;
    std::thread worker_;

    static void check(CURLcode code) {
        // 不输出包含 connectToken 的 URL 或 bootstrap。
        if (code != CURLE_OK) throw std::runtime_error("Neutralino WebSocket connection failed");
    }
    void fail() noexcept {
        connected_ = false;
        changed_.notify_all();
        curl_multi_wakeup(poller_.get());
    }
    void waitSocket(bool write) {
        curl_waitfd socket{socket_, static_cast<short>(write ? CURL_WAIT_POLLOUT : CURL_WAIT_POLLIN), 0};
        if (curl_multi_poll(poller_.get(), &socket, 1, 100, nullptr) != CURLM_OK) fail();
    }
    void closeFrame() noexcept {
        const unsigned char code[]{0x03, 0xe8}; // 正常关闭 1000。
        std::size_t sent = 0;
        curl_ws_send(easy_.get(), code, sizeof(code), &sent, 0, CURLWS_CLOSE);
    }
    void run() noexcept {
        try {
            std::shared_ptr<Outgoing> active;
            std::string message, pong, incomingPing, pingToken;
            std::uint64_t pingSequence = 0;
            auto nextPing = Clock::now() + 5s, pongDeadline = Clock::time_point::max();
            while (connected_ && !stopping_) {
                if (Clock::now() >= pongDeadline) { fail(); break; }
                if (!active) {
                    if (Clock::now() >= nextPing && pongDeadline == Clock::time_point::max()) {
                        active = std::make_shared<Outgoing>();
                        active->text = pingToken = "javm-" + std::to_string(++pingSequence);
                        active->flags = CURLWS_PING;
                        active->business = false;
                        pongDeadline = active->deadline;
                    } else {
                        std::lock_guard lock(mutex_);
                        if (!outgoing_.empty()) { active = outgoing_.front(); outgoing_.pop_front(); }
                    }
                }
                if (active) {
                    if (Clock::now() >= active->deadline) { fail(); break; }
                    std::size_t sent = 0;
                    const auto code = curl_ws_send(easy_.get(), active->text.data() + active->offset,
                        active->text.size() - active->offset, &sent, 0, active->flags);
                    if (code != CURLE_OK && code != CURLE_AGAIN) { fail(); break; }
                    active->offset += sent;
                    if (active->offset < active->text.size() || code == CURLE_AGAIN) {
                        // 整帧发送完成前不插入其他帧，避免交错发送业务与控制帧。
                        waitSocket(true);
                        continue;
                    }
                    if (active->business) {
                        std::lock_guard lock(mutex_);
                        active->complete = true;
                        outgoingBytes_ -= active->text.size();
                        --outgoingCount_;
                        changed_.notify_all();
                    }
                    active.reset();
                }

                char buffer[16384];
                std::size_t count = 0;
                const curl_ws_frame* frame = nullptr;
                const auto code = curl_ws_recv(easy_.get(), buffer, sizeof(buffer), &count, &frame);
                if (code == CURLE_AGAIN) { waitSocket(false); continue; }
                if (code != CURLE_OK || !frame) { fail(); break; }
                if (frame->flags & CURLWS_CLOSE) { closeFrame(); fail(); break; }
                if (frame->flags & CURLWS_PONG) {
                    if (frame->offset == 0) pong.clear();
                    if (count > 125 - pong.size()) { fail(); break; }
                    pong.append(buffer, count);
                    if (!frame->bytesleft && pong == pingToken) {
                        pongDeadline = Clock::time_point::max();
                        nextPing = Clock::now() + 5s;
                    }
                    continue;
                }
                if (frame->flags & CURLWS_PING) {
                    if (frame->offset == 0) incomingPing.clear();
                    if (count > 125 - incomingPing.size()) { fail(); break; }
                    incomingPing.append(buffer, count);
                    if (!frame->bytesleft) {
                        // 显式排入下一次写入，避免空闲连接的自动 Pong 滞留发送缓冲。
                        active = std::make_shared<Outgoing>();
                        active->text = std::move(incomingPing);
                        active->flags = CURLWS_PONG;
                        active->business = false;
                    }
                    continue;
                }
                if (!(frame->flags & CURLWS_TEXT) || (frame->flags & CURLWS_BINARY) ||
                    count > maxMessageBytes - message.size()) { fail(); break; }
                message.append(buffer, count);
                if (frame->bytesleft > static_cast<curl_off_t>(maxMessageBytes - message.size())) { fail(); break; }
                if (frame->bytesleft || (frame->flags & CURLWS_CONT)) continue;
                if (!isValidUtf8(message)) { fail(); break; }
                {
                    std::lock_guard lock(mutex_);
                    if (incoming_.size() >= 64 || message.size() > 8 * 1024 * 1024 - incomingBytes_) { fail(); break; }
                    incomingBytes_ += message.size();
                    incoming_.push_back(std::move(message));
                    message.clear();
                }
                changed_.notify_all();
            }
            if (connected_ && stopping_) closeFrame();
        } catch (...) { /* 传输异常统一断连，主线程负责关闭业务服务。 */ }
        fail();
    }
public:
    explicit CurlTransport(const Bootstrap& boot) {
        if (!easy_ || !poller_) throw std::runtime_error("Cannot create extension connection");
        const std::string url = "ws://127.0.0.1:" + std::to_string(boot.port) + requestTarget(boot);
        check(curl_easy_setopt(easy_.get(), CURLOPT_URL, url.c_str()));
        check(curl_easy_setopt(easy_.get(), CURLOPT_PROTOCOLS_STR, "ws"));
        check(curl_easy_setopt(easy_.get(), CURLOPT_PROXY, ""));
        check(curl_easy_setopt(easy_.get(), CURLOPT_NOPROXY, "*"));
        check(curl_easy_setopt(easy_.get(), CURLOPT_FOLLOWLOCATION, 0L));
        check(curl_easy_setopt(easy_.get(), CURLOPT_NOSIGNAL, 1L));
        check(curl_easy_setopt(easy_.get(), CURLOPT_CONNECTTIMEOUT_MS, 3000L));
        check(curl_easy_setopt(easy_.get(), CURLOPT_TIMEOUT_MS, 5000L));
        check(curl_easy_setopt(easy_.get(), CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1));
        check(curl_easy_setopt(easy_.get(), CURLOPT_CONNECT_ONLY, 2L));
        check(curl_easy_setopt(easy_.get(), CURLOPT_WS_OPTIONS, CURLWS_NOAUTOPONG));
        check(curl_easy_perform(easy_.get()));
        long status = 0;
        check(curl_easy_getinfo(easy_.get(), CURLINFO_RESPONSE_CODE, &status));
        check(curl_easy_getinfo(easy_.get(), CURLINFO_ACTIVESOCKET, &socket_));
        if (status != 101 || socket_ == CURL_SOCKET_BAD) throw std::runtime_error("Neutralino WebSocket handshake failed");
        connected_ = true;
        worker_ = std::thread([this] { run(); });
    }
    ~CurlTransport() override { close(); }
    bool connected() const noexcept override { return connected_ && !stopping_; }
    bool send(std::string message) override {
        if (message.empty() || message.size() > maxMessageBytes) { fail(); return false; }
        auto item = std::make_shared<Outgoing>();
        item->text = std::move(message);
        std::unique_lock lock(mutex_);
        if (!connected()) return false;
        if (outgoingCount_ >= 64 || item->text.size() > 8 * 1024 * 1024 - outgoingBytes_) { fail(); return false; }
        outgoingBytes_ += item->text.size();
        ++outgoingCount_;
        outgoing_.push_back(item);
        curl_multi_wakeup(poller_.get());
        if (!changed_.wait_until(lock, item->deadline, [&] { return item->complete || !connected(); })) {
            fail(); return false;
        }
        return item->complete;
    }
    bool receive(std::string& message) override {
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [&] { return !incoming_.empty() || !connected(); });
        if (!connected()) return false;
        message = std::move(incoming_.front());
        incoming_.pop_front();
        incomingBytes_ -= message.size();
        return true;
    }
    void close() noexcept override {
        stopping_ = true;
        changed_.notify_all();
        curl_multi_wakeup(poller_.get());
        if (worker_.joinable()) worker_.join();
        connected_ = false;
    }
};
}
std::unique_ptr<Transport> connect(const Bootstrap& boot) { return std::make_unique<CurlTransport>(boot); }
} // namespace javm::extension
