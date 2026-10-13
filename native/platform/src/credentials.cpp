#include "credentials.hpp"
#include "../../common/cancellable_thread.hpp"
#include <chrono>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#elif !defined(_WIN32)
#include <libsecret/secret.h>
#endif

namespace javm::platform {
#ifdef __APPLE__
namespace {
template<class T> struct Owned {
    T value;
    explicit Owned(T input): value(input) {}
    Owned(const Owned&) = delete;
    Owned& operator=(const Owned&) = delete;
    Owned(Owned&& other) noexcept: value(std::exchange(other.value, nullptr)) {}
    ~Owned() { if (value) CFRelease(value); }
    operator T() const { return value; }
};
Owned<CFMutableDictionaryRef> query(const std::string& key) {
    Owned<CFMutableDictionaryRef> result{CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks)};
    Owned<CFStringRef> account{CFStringCreateWithBytes(kCFAllocatorDefault,
        reinterpret_cast<const UInt8*>(key.data()), static_cast<CFIndex>(key.size()), kCFStringEncodingUTF8, false)};
    if (!result.value || !account.value) throw std::runtime_error("无法初始化系统钥匙串");
    CFDictionarySetValue(result, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(result, kSecAttrService, CFSTR("net.ddmoyu.javm.settings"));
    CFDictionarySetValue(result, kSecAttrAccount, account);
    // 读取不会弹出阻塞提示；钥匙串锁定时明确报错，由用户在系统中解锁。
    CFDictionarySetValue(result, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
    return result;
}
void check(OSStatus status) {
    if (status != errSecSuccess) throw std::runtime_error("无法访问 macOS 钥匙串，请先解锁登录钥匙串并允许 JAVM 访问后重试");
}
}
struct Credentials::State {};
Credentials::Credentials(): state_(std::make_unique<State>()) {}
Credentials::~Credentials() = default;
void Credentials::cancel() {}
std::optional<std::string> Credentials::read(const std::string& key) {
    auto match = query(key);
    CFDictionarySetValue(match, kSecReturnData, kCFBooleanTrue);
    CFTypeRef raw = nullptr;
    const auto status = SecItemCopyMatching(match, &raw);
    Owned<CFTypeRef> result{raw};
    if (status == errSecItemNotFound) return std::nullopt;
    check(status);
    if (!raw || CFGetTypeID(raw) != CFDataGetTypeID() || CFDataGetLength(static_cast<CFDataRef>(raw)) > 80000)
        throw std::runtime_error("钥匙串配置无效或内容过大");
    const auto data = static_cast<CFDataRef>(raw);
    return std::string(reinterpret_cast<const char*>(CFDataGetBytePtr(data)), static_cast<size_t>(CFDataGetLength(data)));
}
void Credentials::write(const std::string& key, const std::string& value) {
    auto match = query(key);
    Owned<CFDataRef> data{CFDataCreate(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(value.data()), static_cast<CFIndex>(value.size()))};
    Owned<CFMutableDictionaryRef> changes{CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks)};
    if (!data.value || !changes.value) throw std::runtime_error("无法初始化系统钥匙串");
    CFDictionarySetValue(changes, kSecValueData, data);
    auto status = SecItemUpdate(match, changes);
    if (status == errSecItemNotFound) {
        CFDictionarySetValue(match, kSecValueData, data);
        CFDictionarySetValue(match, kSecAttrLabel, CFSTR("JAVM 服务配置"));
        status = SecItemAdd(match, nullptr);
        if (status == errSecDuplicateItem) {
            CFDictionaryRemoveValue(match, kSecValueData);
            CFDictionaryRemoveValue(match, kSecAttrLabel);
            status = SecItemUpdate(match, changes);
        }
    }
    check(status);
}
#elif !defined(_WIN32)
namespace {
const SecretSchema schema = {"net.ddmoyu.javm.settings", SECRET_SCHEMA_NONE,
    {{"key", SECRET_SCHEMA_ATTRIBUTE_STRING}, {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}}, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
void check(GError* error) {
    if (!error) return;
    g_error_free(error);
    throw std::runtime_error("无法访问系统密钥环，请启动并解锁 Secret Service 后重试");
}
// libsecret 的同步 API 支持 GCancellable；超时和退出都不无限等待密钥环弹窗。
class Deadline {
    javm::CancellableThread timer_;
public:
    explicit Deadline(GCancellable* cancel): timer_([cancel](const std::atomic_bool& stop) {
        for (unsigned i = 0; i < 120 && !stop; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (!stop) g_cancellable_cancel(cancel);
    }) {}
};
}
struct Credentials::State {
    std::mutex mutex;
    GCancellable* active = nullptr;
    bool stopped = false;
    struct Operation {
        State& state;
        GCancellable* cancel = g_cancellable_new();
        explicit Operation(State& input): state(input) {
            std::lock_guard lock(state.mutex);
            if (state.stopped) { g_object_unref(cancel); throw std::runtime_error("系统服务正在退出"); }
            state.active = cancel;
        }
        ~Operation() {
            std::lock_guard lock(state.mutex);
            state.active = nullptr;
            g_object_unref(cancel);
        }
    };
};
Credentials::Credentials(): state_(std::make_unique<State>()) {}
Credentials::~Credentials() = default;
void Credentials::cancel() {
    std::lock_guard lock(state_->mutex);
    state_->stopped = true;
    if (state_->active) g_cancellable_cancel(state_->active);
}
std::optional<std::string> Credentials::read(const std::string& key) {
    State::Operation operation(*state_);
    Deadline deadline(operation.cancel);
    GError* error = nullptr;
    auto* value = secret_password_lookup_sync(&schema, operation.cancel, &error, "key", key.c_str(), nullptr);
    struct Release { gchar* value; ~Release() { secret_password_free(value); } } release{value};
    check(error);
    if (!value) return std::nullopt;
    if (std::char_traits<char>::length(value) > 80000) throw std::runtime_error("密钥环配置内容过大");
    return std::string(value);
}
void Credentials::write(const std::string& key, const std::string& value) {
    State::Operation operation(*state_);
    Deadline deadline(operation.cancel);
    GError* error = nullptr;
    const auto saved = secret_password_store_sync(&schema, SECRET_COLLECTION_DEFAULT, "JAVM 服务配置",
        value.c_str(), operation.cancel, &error, "key", key.c_str(), nullptr);
    check(error);
    if (!saved) throw std::runtime_error("系统密钥环未保存配置，请解锁后重试");
}
#else
struct Credentials::State {};
Credentials::Credentials(): state_(std::make_unique<State>()) {}
Credentials::~Credentials() = default;
void Credentials::cancel() {}
std::optional<std::string> Credentials::read(const std::string&) { throw std::runtime_error("Windows 配置应使用当前用户 DPAPI"); }
void Credentials::write(const std::string&, const std::string&) { throw std::runtime_error("Windows 配置应使用当前用户 DPAPI"); }
#endif
}
