#pragma once
#include "extension_protocol.hpp"
#include <memory>

namespace javm::extension {
class Transport {
public:
    virtual ~Transport() = default;
    // receive 只有一个调用者；send 可由有限业务工作线程调用。
    // true 表示整条消息已发送。关闭前由应用先停止并回收业务工作线程。
    virtual bool send(std::string message) = 0;
    virtual bool receive(std::string& message) = 0;
    virtual bool connected() const noexcept = 0;
    virtual void close() noexcept = 0;
};
std::unique_ptr<Transport> connect(const Bootstrap& boot);
} // namespace javm::extension
