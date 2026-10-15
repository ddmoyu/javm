#include "privacy.hpp"
#include <stdexcept>
namespace javm::platform {
struct Privacy::State {};
Privacy::Privacy(unsigned long, std::function<void()>): state_(std::make_unique<State>()) {}
Privacy::~Privacy() = default;
void Privacy::shutdown() {}
void Privacy::request(const std::string&, const std::string&, const Service::Json&, Service::Reply) {
    throw std::runtime_error("当前平台不支持 Windows 全局老板键和最近文件保护");
}
}
