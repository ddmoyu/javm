#include "extension_transport.hpp"
#include <windows.h>
#include <winhttp.h>
#include <atomic>
#include <mutex>

namespace javm::extension {
namespace {
class Handle {
    HINTERNET value_ = nullptr;
public:
    ~Handle() { if (value_) WinHttpCloseHandle(value_); }
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    void set(HINTERNET value) {
        if (!value) throw std::runtime_error("Neutralino WinHTTP connection failed");
        value_ = value;
    }
    HINTERNET get() const { return value_; }
};
class WinHttpTransport final : public Transport {
    Handle session_, connection_, request_, socket_;
    std::atomic_bool connected_{true};
    std::mutex sendMutex_;
public:
    explicit WinHttpTransport(const Bootstrap& boot) {
        // queryValue 的结果只有 ASCII，不再需要 Win32 字符编码转换。
        const auto target = requestTarget(boot);
        const std::wstring wideTarget(target.begin(), target.end());
        session_.set(WinHttpOpen(L"JAVM.Database/1", WINHTTP_ACCESS_TYPE_NO_PROXY,
            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
        connection_.set(WinHttpConnect(session_.get(), L"127.0.0.1", boot.port, 0));
        request_.set(WinHttpOpenRequest(connection_.get(), L"GET", wideTarget.c_str(), nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
        if (!WinHttpSetOption(request_.get(), WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) ||
            !WinHttpSendRequest(request_.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
            !WinHttpReceiveResponse(request_.get(), nullptr)) throw std::runtime_error("Neutralino connection failed");
        DWORD status = 0, size = sizeof(status);
        if (!WinHttpQueryHeaders(request_.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) || status != 101)
            throw std::runtime_error("Neutralino WebSocket handshake failed");
        socket_.set(WinHttpWebSocketCompleteUpgrade(request_.get(), 0));
    }
    bool connected() const noexcept override { return connected_; }
    bool send(std::string message) override {
        std::lock_guard lock(sendMutex_);
        if (!connected_ || message.size() > maxMessageBytes) return false;
        if (WinHttpWebSocketSend(socket_.get(), WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                message.data(), static_cast<DWORD>(message.size())) == NO_ERROR) return true;
        connected_ = false;
        return false;
    }
    bool receive(std::string& message) override {
        message.clear();
        while (connected_) {
            char buffer[16384];
            DWORD read = 0;
            WINHTTP_WEB_SOCKET_BUFFER_TYPE type{};
            if (WinHttpWebSocketReceive(socket_.get(), buffer, sizeof(buffer), &read, &type) != NO_ERROR ||
                type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) break;
            if (type != WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE && type != WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)
                throw std::runtime_error("Extension requires text messages");
            if (read > maxMessageBytes - message.size()) throw std::runtime_error("Extension message too large");
            message.append(buffer, read);
            if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
                if (!isValidUtf8(message)) throw std::runtime_error("Invalid extension UTF-8");
                return true;
            }
        }
        connected_ = false;
        return false;
    }
    void close() noexcept override {
        std::lock_guard lock(sendMutex_);
        connected_ = false;
        WinHttpWebSocketClose(socket_.get(), WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
    }
};
}
std::unique_ptr<Transport> connect(const Bootstrap& boot) { return std::make_unique<WinHttpTransport>(boot); }
} // namespace javm::extension
