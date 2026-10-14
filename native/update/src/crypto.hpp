#pragma once
#include <atomic>
#include <filesystem>
#include <string>
#include <vector>
namespace javm::update {
std::vector<unsigned char> unhex(const std::string &value);
std::string hex(const unsigned char *data, size_t size);
std::string hashFile(const std::filesystem::path &path,
                     const std::atomic<bool> *cancel = nullptr);
bool verifySignature(const std::string &payload, const std::string &signature,
                     const std::string &publicKey);
} // namespace javm::update
