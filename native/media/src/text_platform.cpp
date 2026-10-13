#include "file_platform.hpp"
#ifdef _WIN32
#include <windows.h>
#else
#include <unicode/ucol.h>
#include <unicode/ustring.h>
#endif

namespace media {
std::string unicodeLower(const std::string& text) {
    if (text.empty()) return {};
#ifdef _WIN32
    const auto source = wide(text);
    const auto size = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, source.data(), static_cast<int>(source.size()), nullptr, 0, nullptr, nullptr, 0);
    if (!size) throw std::runtime_error("无法转换查询文本");
    std::wstring mapped(size, L'\0');
    if (!LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, source.data(), static_cast<int>(source.size()), mapped.data(), size, nullptr, nullptr, 0))
        throw std::runtime_error("无法转换查询文本");
    return utf8(mapped);
#else
    UErrorCode error = U_ZERO_ERROR;
    int32_t size = 0;
    u_strFromUTF8(nullptr, 0, &size, text.data(), static_cast<int32_t>(text.size()), &error);
    if (error != U_BUFFER_OVERFLOW_ERROR) throw std::runtime_error("查询文本不是有效的 UTF-8");
    error = U_ZERO_ERROR;
    std::u16string source(static_cast<size_t>(size), u'\0');
    u_strFromUTF8(reinterpret_cast<UChar*>(source.data()), size, nullptr, text.data(), static_cast<int32_t>(text.size()), &error);
    if (U_FAILURE(error)) throw std::runtime_error("无法转换查询文本");
    error = U_ZERO_ERROR;
    const auto count = u_strToLower(nullptr, 0, reinterpret_cast<const UChar*>(source.data()), size, "", &error);
    if (error != U_BUFFER_OVERFLOW_ERROR) throw std::runtime_error("无法转换查询文本");
    error = U_ZERO_ERROR;
    std::u16string lowered(static_cast<size_t>(count), u'\0');
    u_strToLower(reinterpret_cast<UChar*>(lowered.data()), count, reinterpret_cast<const UChar*>(source.data()), size, "", &error);
    if (U_FAILURE(error)) throw std::runtime_error("无法转换查询文本");
    error = U_ZERO_ERROR;
    u_strToUTF8(nullptr, 0, &size, reinterpret_cast<const UChar*>(lowered.data()), count, &error);
    if (error != U_BUFFER_OVERFLOW_ERROR) throw std::runtime_error("无法转换查询文本");
    error = U_ZERO_ERROR;
    std::string result(static_cast<size_t>(size), '\0');
    u_strToUTF8(result.data(), size, nullptr, reinterpret_cast<const UChar*>(lowered.data()), count, &error);
    if (U_FAILURE(error)) throw std::runtime_error("无法转换查询文本");
    return result;
#endif
}
int compareNatural(const std::string& left, const std::string& right) {
    if (left.empty() || right.empty()) return left.empty() == right.empty() ? 0 : left.empty() ? -1 : 1;
#ifdef _WIN32
    const auto a = wide(left), b = wide(right);
    const auto result = CompareStringEx(L"zh-CN", NORM_IGNORECASE | NORM_IGNORENONSPACE | SORT_DIGITSASNUMBERS,
        a.data(), static_cast<int>(a.size()), b.data(), static_cast<int>(b.size()), nullptr, nullptr, 0);
    if (result) return result - CSTR_EQUAL;
#else
    struct Collator {
        UCollator* value = nullptr;
        Collator() {
            UErrorCode error = U_ZERO_ERROR;
            value = ucol_open("zh_CN", &error);
            if (U_SUCCESS(error)) {
                ucol_setAttribute(value, UCOL_STRENGTH, UCOL_PRIMARY, &error);
                ucol_setAttribute(value, UCOL_NUMERIC_COLLATION, UCOL_ON, &error);
            }
            if (U_FAILURE(error)) { if (value) ucol_close(value); value = nullptr; }
        }
        ~Collator() { if (value) ucol_close(value); }
    };
    thread_local Collator collator;
    if (collator.value) {
        UErrorCode error = U_ZERO_ERROR;
        const auto result = ucol_strcollUTF8(collator.value, left.data(), static_cast<int32_t>(left.size()), right.data(), static_cast<int32_t>(right.size()), &error);
        if (U_SUCCESS(error)) return static_cast<int>(result);
    }
#endif
    return left.compare(right);
}
}
