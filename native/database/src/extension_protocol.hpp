#pragma once
#include "../../common/utf8.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <charconv>
#include <istream>
#include <random>
#include <stdexcept>
#include <string>

namespace javm::extension {
inline constexpr std::size_t maxMessageBytes = 4 * 1024 * 1024;
struct Bootstrap {
    unsigned short port;
    std::string token, extensionId, connectToken;
};

inline Bootstrap readBootstrap(std::istream& input) {
    // stdin 只接收官方启动信封；有界读取，业务仍全部走官方 WebSocket。
    std::string text;
    char ch;
    while (input.get(ch)) {
        if (text.size() == 64 * 1024) throw std::runtime_error("Extension bootstrap too large");
        text += ch;
    }
    const auto value = nlohmann::json::parse(text, nullptr, false);
    if (!value.is_object()) throw std::runtime_error("Invalid extension bootstrap");
    const auto field = [&](const char* name) {
        if (!value.contains(name) || !value[name].is_string())
            throw std::runtime_error("Invalid extension bootstrap field");
        auto result = value[name].get<std::string>();
        if (result.empty() || result.size() > 4096 || !isValidUtf8(result) ||
            result.find_first_of(std::string("\0\r\n", 3)) != std::string::npos)
            throw std::runtime_error("Invalid extension bootstrap field");
        return result;
    };
    unsigned port = 0;
    const auto rawPort = value.value("nlPort", nlohmann::json());
    if (rawPort.is_string()) {
        const auto digits = rawPort.get<std::string>();
        const auto parsed = std::from_chars(digits.data(), digits.data() + digits.size(), port);
        if (parsed.ec != std::errc{} || parsed.ptr != digits.data() + digits.size())
            throw std::runtime_error("Invalid extension port");
    } else if (rawPort.is_number_integer() && rawPort >= 1 && rawPort <= 65535) {
        port = rawPort.get<unsigned>();
    }
    if (port < 1 || port > 65535) throw std::runtime_error("Invalid extension port");
    return {static_cast<unsigned short>(port), field("nlToken"), field("nlExtensionId"), field("nlConnectToken")};
}

inline std::string queryValue(const std::string& value) {
    constexpr char hex[] = "0123456789ABCDEF";
    std::string result;
    for (const unsigned char ch : value) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
            ch == '-' || ch == '.' || ch == '_' || ch == '~') result += static_cast<char>(ch);
        else { result += '%'; result += hex[ch >> 4]; result += hex[ch & 15]; }
    }
    return result;
}
inline std::string requestTarget(const Bootstrap& boot) {
    return "/?extensionId=" + queryValue(boot.extensionId) + "&connectToken=" + queryValue(boot.connectToken);
}
inline std::string messageId() {
    std::random_device random;
    std::array<unsigned char, 16> bytes{};
    for (auto& byte : bytes) byte = static_cast<unsigned char>(random());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) result += '-';
        result += hex[bytes[i] >> 4]; result += hex[bytes[i] & 15];
    }
    return result;
}
inline std::string responseEnvelope(const Bootstrap& boot, const nlohmann::json& response) {
    return nlohmann::json{{"id", messageId()}, {"method", "app.broadcast"}, {"accessToken", boot.token},
        {"data", {{"event", "javm.database.response"}, {"data", response}}}}.dump();
}
} // namespace javm::extension
