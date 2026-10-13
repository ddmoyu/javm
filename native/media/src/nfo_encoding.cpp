#include "nfo_compat.hpp"
#include "../../common/unicode.hpp"
#ifdef _WIN32
#include <windows.h>
#else
#include <iconv.h>
#endif
#include <algorithm>
#include <cstdint>

namespace media::nfo {
void warn(Json& result, const std::string& message) {
    auto& warnings = result["_warnings"];
    if (warnings.is_null()) warnings = Json::array();
    if (warnings.size() < 20 && std::find(warnings.begin(),warnings.end(),message) == warnings.end()) warnings.push_back(message);
}
namespace {
bool xmlCharacter(uint32_t value) {
    return value == 9 || value == 10 || value == 13 || (value >= 0x20 && value <= 0xd7ff) ||
        (value >= 0xe000 && value <= 0xfffd) || (value >= 0x10000 && value <= 0x10ffff);
}
std::string declaredEncoding(const std::string& bytes) {
    auto head = lower(bytes.substr(0,256));
    if (!head.starts_with("<?xml")) return {};
    const auto end = head.find("?>");
    const auto position = head.find("encoding");
    if (position == std::string::npos || position > end) return {};
    const auto equals = head.find('=',position+8);
    if (equals == std::string::npos || equals > end) return {};
    const auto quote = head.find_first_of("\"'",equals+1);
    if (quote == std::string::npos || quote > end) return {};
    const auto close = head.find(head[quote],quote+1);
    return close == std::string::npos || close > end ? "" : head.substr(quote+1,close-quote-1);
}
std::string fromCodePage(const std::string& bytes, unsigned codepage) {
    if (bytes.empty()) return {};
#ifdef _WIN32
    const auto length = MultiByteToWideChar(codepage,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(bytes.size()),nullptr,0);
    if (!length) throw std::runtime_error("NFO 文本编码无效，原文件已保留");
    std::wstring buffer(length,L'\0');
    MultiByteToWideChar(codepage,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(bytes.size()),buffer.data(),length);
    return utf8(buffer);
#else
    if (codepage == 65001) {
        if (!javm::isValidUtf8(bytes)) throw std::runtime_error("NFO 文本编码无效，原文件已保留");
        return bytes;
    }
    const char* source = codepage == 54936 ? "GB18030" : codepage == 950 ? "CP950" : "CP932";
    const auto converter = ::iconv_open("UTF-8", source);
    if (converter == reinterpret_cast<iconv_t>(-1)) throw std::runtime_error("系统不支持该 NFO 文本编码");
    struct Close { iconv_t value; ~Close() { ::iconv_close(value); } } close{converter};
    // NFO 输入已限制 2 MiB；保守预留每字节最多四个 UTF-8 字节。
    std::string output(bytes.size() * 4 + 32, '\0');
    char* input = const_cast<char*>(bytes.data());
    char* next = output.data();
    size_t remaining = bytes.size(), available = output.size();
    const auto converted = ::iconv(converter, &input, &remaining, &next, &available);
    if (converted != 0 || remaining || ::iconv(converter, nullptr, nullptr, &next, &available) != 0)
        throw std::runtime_error("NFO 文本编码无效，原文件已保留");
    output.resize(output.size() - available);
    if (!javm::isValidUtf8(output)) throw std::runtime_error("NFO 转换结果不是 UTF-8");
    return output;
#endif
}
}
std::string decode(const std::string& bytes, Json& result) {
    auto byte = [&](size_t i) { return static_cast<uint32_t>(static_cast<unsigned char>(bytes[i])); };
    if (bytes.size() >= 4) {
        bool little32 = bytes.compare(0,4,"\xff\xfe\0\0",4) == 0 || (byte(0) == '<' && byte(1) == 0 && byte(2) == 0 && byte(3) == 0);
        bool big32 = bytes.compare(0,4,"\0\0\xfe\xff",4) == 0 || (byte(0) == 0 && byte(1) == 0 && byte(2) == 0 && byte(3) == '<');
        if (little32 || big32) {
            if (bytes.size()%4) throw std::runtime_error("NFO UTF-32 数据不完整");
            std::u32string buffer;
            for (size_t i = 0; i < bytes.size(); i += 4) {
                uint32_t value = little32 ? byte(i)|(byte(i+1)<<8)|(byte(i+2)<<16)|(byte(i+3)<<24) : (byte(i)<<24)|(byte(i+1)<<16)|(byte(i+2)<<8)|byte(i+3);
                if (i == 0 && value == 0xfeff) continue;
                if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw std::runtime_error("NFO UTF-32 字符无效");
                buffer.push_back(static_cast<char32_t>(value));
            }
            result["_encoding"] = little32 ? "UTF-32LE" : "UTF-32BE";
            return javm::toUtf8<char32_t>(buffer);
        }
    }
    if (bytes.size() >= 2) {
        const bool little = bytes.starts_with("\xff\xfe") || (byte(0) == '<' && byte(1) == 0);
        const bool big = bytes.starts_with("\xfe\xff") || (byte(0) == 0 && byte(1) == '<');
        if (little || big) {
            if (bytes.size()%2) throw std::runtime_error("NFO UTF-16 数据不完整");
            std::u16string buffer;
            for (size_t i = 0; i < bytes.size(); i += 2) {
                const auto value = little ? byte(i)|(byte(i+1)<<8) : (byte(i)<<8)|byte(i+1);
                if (i == 0 && value == 0xfeff) continue;
                buffer.push_back(static_cast<char16_t>(value));
            }
            result["_encoding"] = little ? "UTF-16LE" : "UTF-16BE";
            return javm::toUtf8<char16_t>(buffer);
        }
    }
    constexpr unsigned utf8CodePage = 65001;
    if (bytes.starts_with("\xef\xbb\xbf")) { result["_encoding"] = "UTF-8 BOM"; return fromCodePage(bytes.substr(3),utf8CodePage); }
    const auto encoding = declaredEncoding(bytes);
    unsigned codepage = utf8CodePage;
    if (encoding == "gbk" || encoding == "gb2312" || encoding == "gb18030") codepage = 54936;
    else if (encoding == "big5" || encoding == "big-5") codepage = 950;
    else if (encoding == "shift_jis" || encoding == "shift-jis" || encoding == "windows-31j") codepage = 932;
    else if (!encoding.empty() && encoding != "utf-8" && encoding != "utf8" && encoding != "us-ascii")
        throw std::runtime_error("NFO 声明了暂不支持的编码：" + encoding);
    try {
        auto decoded = fromCodePage(bytes,codepage);
        result["_encoding"] = encoding.empty() ? "UTF-8" : encoding;
        if (codepage != utf8CodePage) warn(result,"已按声明的旧文本编码读取，原始字节已保留");
        return decoded;
    } catch (const std::exception&) {
        if (!encoding.empty()) throw;
        auto decoded = fromCodePage(bytes,54936);
        result["_encoding"] = "GB18030 (fallback)";
        warn(result,"无编码声明且不是 UTF-8，暂按 GB18030 读取，请核对文字");
        return decoded;
    }
}
std::string repair(const std::string& source, Json& result) {
    auto unicode = wide(source);
    std::erase_if(unicode,[&](wchar_t ch) {
        const auto value = static_cast<uint32_t>(ch);
        // 有效 UTF-16 代理对由编码转换校验；只移除 XML 禁用的 BMP 控制字符。
        const bool remove = value < 0xd800 || value > 0xdfff ? !xmlCharacter(value) : false;
        if (remove) warn(result,"已忽略 XML 禁用控制字符，原始字节已保留");
        return remove;
    });
    const auto clean = utf8(unicode);
    std::string output;
    output.reserve(clean.size());
    for (size_t i = 0; i < clean.size();) {
        std::string_view rest(clean.data()+i,clean.size()-i);
        const char* endToken = rest.starts_with("<![CDATA[") ? "]]>" : rest.starts_with("<!--") ? "-->" : rest.starts_with("<?") ? "?>" : nullptr;
        if (endToken) {
            const auto end = clean.find(endToken,i+2);
            const auto count = end == std::string::npos ? clean.size()-i : end+std::char_traits<char>::length(endToken)-i;
            output.append(clean,i,count); i += count; continue;
        }
        if (clean[i] != '&') { output.push_back(clean[i++]); continue; }
        // 实体最长只接受 16 字节，避免大量裸 & 反复扫描整个剩余文件。
        const auto semicolon = rest.substr(1,16).find(';');
        bool entity = false;
        if (semicolon != std::string_view::npos) {
            const auto token = rest.substr(1,semicolon);
            entity = token == "amp" || token == "lt" || token == "gt" || token == "quot" || token == "apos";
            if (token.starts_with('#')) {
                const bool hex = token.size() > 1 && (token[1] == 'x' || token[1] == 'X');
                const auto digits = token.substr(hex ? 2 : 1);
                uint32_t value = 0;
                const auto parsed = std::from_chars(digits.data(),digits.data()+digits.size(),value,hex ? 16 : 10);
                entity = !digits.empty() && parsed.ec == std::errc{} && parsed.ptr == digits.data()+digits.size() && xmlCharacter(value);
            }
        }
        if (entity) output.push_back('&');
        else { output += "&amp;"; warn(result,"已兼容未转义的 & 或未知实体，原始字节已保留"); }
        ++i;
    }
    return output;
}
}
