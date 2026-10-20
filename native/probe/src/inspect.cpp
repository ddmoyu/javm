#include "probe.hpp"
#include "../../common/utf8.hpp"
#include <semaphore>
#include <thread>

namespace javm::probe {
Json decodeResult(const std::string& text) {
    if (text.empty() || text.size() > outputLimit || !isValidUtf8(text)) throw std::runtime_error("视频探测结果无效");
    const auto result = Json::parse(text, nullptr, false);
    if (!result.is_object() || !result.contains("video") || !result["video"].is_boolean() ||
        !result.contains("audio") || !result["audio"].is_boolean()) throw std::runtime_error("视频探测结果无效");
    for (const auto* key : {"videoTracks", "audioTracks", "durationMs", "audioChannels", "width", "height"}) {
        if (!result.contains(key) || !result[key].is_number_integer() || result[key] < 0 || result[key] > 9'007'199'254'740'991LL)
            throw std::runtime_error("视频探测数值无效");
    }
    for (const auto* key : {"audioLanguage", "codec"}) if (!result.contains(key) || !result[key].is_string() || result[key].get_ref<const std::string&>().size() > 4096)
        throw std::runtime_error("视频探测字段无效");
    return result;
}
Json inspect(const fs::path& worker, const fs::path& file, const std::atomic_bool& cancelled, std::chrono::milliseconds timeout) {
    static std::counting_semaphore<16> slots(concurrencyLimit(std::thread::hardware_concurrency()));
    while (!slots.try_acquire_for(std::chrono::milliseconds(25))) if (cancelled) throw std::runtime_error("媒体探测已取消");
    struct Release { ~Release() { slots.release(); } } release;
    if (cancelled) throw std::runtime_error("媒体探测已取消");
    if (!worker.is_absolute() || !file.is_absolute() || timeout.count() <= 0 || timeout > defaultTimeout)
        throw std::runtime_error("媒体探测启动参数无效");
    return decodeResult(capture(worker, file, cancelled, timeout));
}
} // namespace javm::probe
