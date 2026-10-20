#include "../../native/common/utf8.hpp"
#include <array>
#include <iostream>
#include <string>

static_assert(javm::isValidUtf8("Safe compile fixture"));
static_assert(!javm::isValidUtf8("\xed\xa0\x80"));

int main() {
    constexpr std::array valid{
        std::string_view(""), std::string_view("Safe ASCII"), std::string_view("A\0B", 3),
        std::string_view("\xc2\x80"), std::string_view("\xdf\xbf"),
        std::string_view("\xe0\xa0\x80"), std::string_view("\xed\x9f\xbf"),
        std::string_view("\xee\x80\x80"), std::string_view("\xef\xbf\xbf"),
        std::string_view("\xf0\x90\x80\x80"), std::string_view("\xf4\x8f\xbf\xbf"),
        std::string_view("\xe5\xae\x89\xe5\x85\xa8 \xf0\x9f\x8c\xb1")
    };
    constexpr std::array invalid{
        "\x80", "\xbf", "\xc0\x80", "\xc1\xbf", "\xc2", "\xc2\x20",
        "\xe0\x9f\xbf", "\xe1\x80", "\xe1\x80\x20", "\xed\xa0\x80", "\xed\xbf\xbf",
        "\xf0\x8f\xbf\xbf", "\xf0\x90\x80", "\xf0\x90\x20\x80", "\xf4\x90\x80\x80",
        "\xf5\x80\x80\x80", "\xf8\x88\x80\x80\x80", "\xfe", "\xff", "Safe\xff"
    };
    for (const auto value : valid) if (!javm::isValidUtf8(value)) return 1;
    for (const auto value : invalid) if (javm::isValidUtf8(value)) return 2;

    // 覆盖每个 Unicode 标量及其截断形式，避免只验证少量常见字符。
    std::size_t scalars = 0;
    for (std::uint32_t cp = 0; cp <= 0x10ffff; ++cp) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        std::string value;
        const auto append = [&value](std::uint32_t byte) { value += static_cast<char>(byte); };
        if (cp < 0x80) append(cp);
        else if (cp < 0x800) {
            append(0xc0 | (cp >> 6)); append(0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
            append(0xe0 | (cp >> 12)); append(0x80 | ((cp >> 6) & 0x3f)); append(0x80 | (cp & 0x3f));
        } else {
            append(0xf0 | (cp >> 18)); append(0x80 | ((cp >> 12) & 0x3f));
            append(0x80 | ((cp >> 6) & 0x3f)); append(0x80 | (cp & 0x3f));
        }
        if (!javm::isValidUtf8(value)) return 3;
        for (std::size_t length = 1; length < value.size(); ++length)
            if (javm::isValidUtf8(std::string_view(value).substr(0, length))) return 4;
        ++scalars;
    }
    std::cout << "UTF-8 portability: " << scalars << " Unicode scalars and truncated sequences; "
              << valid.size() + invalid.size() << " boundary fixtures passed.\n";
}
