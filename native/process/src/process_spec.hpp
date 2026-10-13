#pragma once
#include "../../common/utf8.hpp"
#include <nlohmann/json.hpp>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace javm::process {
inline constexpr std::size_t maxPayloadBytes = 256 * 1024;
struct Spec {
    std::string file;
    std::vector<std::string> args;
    std::map<std::string, std::string> envs;
    int timeoutMs = 0;
};
inline Spec parseSpec(std::string_view input) {
    const auto invalid = [] { throw std::runtime_error("Invalid process payload"); };
    if (input.size() > maxPayloadBytes) invalid();
    // 不回显 JSON 异常上下文，参数中可能含访问令牌。
    const auto data = nlohmann::json::parse(input, nullptr, false);
    if (!data.is_object() || data.value("schema", nlohmann::json()) != 1 ||
        !data.contains("file") || !data.contains("args") || !data["args"].is_array() ||
        data["args"].size() > 1024) invalid();
    std::size_t bytes = 0;
    const auto string = [&](const nlohmann::json& value) {
        if (!value.is_string()) invalid();
        auto result = value.get<std::string>();
        bytes += result.size() + 1;
        if (bytes > 128 * 1024 || result.find('\0') != std::string::npos || !isValidUtf8(result)) invalid();
        return result;
    };
    Spec spec;
    spec.file = string(data["file"]);
    if (spec.file.empty() || spec.file.front() != '/') invalid();
    for (const auto& arg : data["args"]) spec.args.push_back(string(arg));
    if (data.contains("envs")) {
        if (!data["envs"].is_object() || data["envs"].size() > 64) invalid();
        for (const auto& [key, value] : data["envs"].items()) {
            const auto letter = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; };
            if (key.empty() || !letter(key.front())) invalid();
            for (const char c : key) if (!letter(c) && !(c >= '0' && c <= '9')) invalid();
            bytes += key.size() + 1;
            spec.envs.emplace(key, string(value));
        }
    }
    if (data.contains("timeoutMs")) {
        const auto& timeout = data["timeoutMs"];
        if (!timeout.is_number_integer() || timeout < 0 || timeout > 86'400'000) invalid();
        spec.timeoutMs = timeout.get<int>();
    }
    return spec;
}
} // namespace javm::process
