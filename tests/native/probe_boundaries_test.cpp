#include "probe.hpp"
#include "../../native/common/unicode.hpp"
#include <iostream>

int main() {
    using javm::probe::Json;
    int checks = 0;
    const auto require = [&](bool valid) { if (!valid) throw std::runtime_error("Boundary check failed"); ++checks; };
    const auto rejects = [&](auto operation) {
        try { operation(); }
        catch (...) { ++checks; return; }
        throw std::runtime_error("Expected rejection");
    };
    try {
        const std::string text = "ASCII 中文 空格😀 𐐷";
        const auto utf16 = javm::fromUtf8<char16_t>(text);
        const auto utf32 = javm::fromUtf8<char32_t>(text);
        require(javm::toUtf8(std::u16string_view(utf16)) == text);
        require(javm::toUtf8(std::u32string_view(utf32)) == text);
        require(utf16.size() == utf32.size() + 2);
        rejects([] { javm::fromUtf8("\xc0\xaf"); });
        rejects([] { javm::toUtf8(std::u16string_view(u"\xd800")); });
        rejects([] { javm::toUtf8(std::u16string_view(u"\xdc00")); });
        rejects([] { javm::toUtf8(std::u32string_view(U"\x110000")); });
        for (const unsigned count : {0u, 1u, 2u, 3u, 4u, 18u, 32u, 999u}) {
            const auto expected = count <= 2 ? 1 : count > 18 ? 16 : count - 2;
            require(javm::probe::concurrencyLimit(count) == expected);
        }
        const Json valid{{"video", true}, {"audio", true}, {"videoTracks", 1}, {"audioTracks", 1},
            {"durationMs", 2001}, {"audioChannels", 2}, {"audioLanguage", "中文"}, {"width", 320}, {"height", 240}, {"codec", "安全编码"}};
        require(javm::probe::decodeResult(valid.dump()) == valid);
        rejects([] { javm::probe::decodeResult("{"); });
        rejects([] { javm::probe::decodeResult("[]"); });
        rejects([] { javm::probe::decodeResult(std::string(17000, 'x')); });
        for (const auto* key : {"video", "audio", "videoTracks", "audioTracks", "durationMs", "audioChannels", "audioLanguage", "width", "height", "codec"}) {
            auto value = valid; value.erase(key);
            rejects([&] { javm::probe::decodeResult(value.dump()); });
        }
        for (const Json& value : {Json(-1), Json(0.5), Json("1"), Json(9'007'199'254'740'992LL)}) {
            auto data = valid; data["durationMs"] = value;
            rejects([&] { javm::probe::decodeResult(data.dump()); });
        }
        require(javm::probe::pathToUtf8(javm::probe::pathFromUtf8(text)) == text);
        rejects([] { javm::probe::pathFromUtf8(std::string("a\0b", 3)); });
        std::cout << "Probe boundary checks: " << checks << '\n';
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
