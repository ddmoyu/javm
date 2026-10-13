#pragma once
#include "utf8.hpp"
#include <stdexcept>
#include <string>
#include <string_view>

namespace javm {
// wchar_t 在 Windows 为 UTF-16，在 POSIX 为 UTF-32；不依赖全局 locale。
template<class Wide = wchar_t>
std::basic_string<Wide> fromUtf8(std::string_view text) {
    static_assert(sizeof(Wide) == 2 || sizeof(Wide) == 4);
    if (!isValidUtf8(text)) throw std::runtime_error("文本不是有效 UTF-8");
    std::basic_string<Wide> result;
    for (std::size_t i = 0; i < text.size();) {
        auto code = static_cast<std::uint32_t>(static_cast<unsigned char>(text[i++]));
        const int remaining = code < 0x80 ? 0 : code < 0xe0 ? 1 : code < 0xf0 ? 2 : 3;
        if (remaining) code &= (1u << (6 - remaining)) - 1;
        for (int j = 0; j < remaining; ++j) code = (code << 6) | (static_cast<unsigned char>(text[i++]) & 0x3f);
        if constexpr (sizeof(Wide) == 2) {
            if (code > 0xffff) {
                code -= 0x10000;
                result.push_back(static_cast<Wide>(0xd800 + (code >> 10)));
                result.push_back(static_cast<Wide>(0xdc00 + (code & 0x3ff)));
                continue;
            }
        }
        result.push_back(static_cast<Wide>(code));
    }
    return result;
}
template<class Wide>
std::string toUtf8(std::basic_string_view<Wide> text) {
    static_assert(sizeof(Wide) == 2 || sizeof(Wide) == 4);
    std::string result;
    for (std::size_t i = 0; i < text.size(); ++i) {
        auto code = static_cast<std::uint32_t>(text[i]);
        if constexpr (sizeof(Wide) == 2) {
            if (code >= 0xd800 && code <= 0xdbff) {
                if (++i == text.size()) throw std::runtime_error("文本包含孤立代理项");
                const auto low = static_cast<std::uint32_t>(text[i]);
                if (low < 0xdc00 || low > 0xdfff) throw std::runtime_error("文本包含孤立代理项");
                code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
            }
        }
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw std::runtime_error("文本包含无效码点");
        if (code < 0x80) result.push_back(static_cast<char>(code));
        else {
            const int extra = code < 0x800 ? 1 : code < 0x10000 ? 2 : 3;
            result.push_back(static_cast<char>((extra == 1 ? 0xc0 : extra == 2 ? 0xe0 : 0xf0) | (code >> (6 * extra))));
            for (int j = extra - 1; j >= 0; --j) result.push_back(static_cast<char>(0x80 | ((code >> (6 * j)) & 0x3f)));
        }
    }
    return result;
}
} // namespace javm
