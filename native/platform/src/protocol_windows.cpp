#include "protocol.hpp"
#include <stdexcept>
namespace javm::platform {
nlohmann::json protocol(const nlohmann::json&) { throw std::runtime_error("Windows 链接关联使用注册表适配"); }
}
