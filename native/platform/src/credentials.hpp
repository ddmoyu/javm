#pragma once
#include <memory>
#include <optional>
#include <string>

namespace javm::platform {
class Credentials {
    struct State;
    std::unique_ptr<State> state_;
public:
    Credentials();
    ~Credentials();
    Credentials(const Credentials&) = delete;
    Credentials& operator=(const Credentials&) = delete;
    std::optional<std::string> read(const std::string& key);
    void write(const std::string& key, const std::string& value);
    void cancel();
};
}
