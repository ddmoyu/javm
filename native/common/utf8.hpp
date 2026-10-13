#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace javm {
// RFC 3629：拒绝过长编码、代理项、截断序列及超出 Unicode 范围的码点。
// 不分配内存；空字符串和嵌入 NUL 都是合法 UTF-8，调用方另行校验字段语义。
constexpr bool isValidUtf8(std::string_view text) noexcept {
    std::size_t offset = 0;
    while (offset < text.size()) {
        const auto first = static_cast<unsigned char>(text[offset++]);
        if (first < 0x80) continue;
        std::uint32_t codepoint = 0, minimum = 0;
        std::size_t remaining = 0;
        if (first >= 0xc2 && first <= 0xdf) {
            codepoint = first & 0x1f; minimum = 0x80; remaining = 1;
        } else if (first >= 0xe0 && first <= 0xef) {
            codepoint = first & 0x0f; minimum = 0x800; remaining = 2;
        } else if (first >= 0xf0 && first <= 0xf4) {
            codepoint = first & 0x07; minimum = 0x10000; remaining = 3;
        } else return false;
        if (remaining > text.size() - offset) return false;
        for (std::size_t i = 0; i < remaining; ++i) {
            const auto next = static_cast<unsigned char>(text[offset++]);
            if ((next & 0xc0) != 0x80) return false;
            codepoint = (codepoint << 6) | (next & 0x3f);
        }
        if (codepoint < minimum || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    }
    return true;
}
} // namespace javm
