#pragma once
#include "files.hpp"
#include <atomic>
#include <functional>
#include <vector>
namespace javm::update {
struct TransferResult {
  bool ok = false, rangeUnsupported = false;
};
using TransferProgress = std::function<void(uint64_t)>;
using UpdateTransfer = std::function<TransferResult(
    const std::string &, const fs::path &, uint64_t, uint64_t,
    const std::string &, const std::atomic<bool> &, const TransferProgress &)>;
using DownloadProgress =
    std::function<void(uint64_t, uint64_t, const std::string &, bool)>;
std::vector<std::string> updateDownloadSources(const Json &request);
void fetchUpdateFile(const fs::path &file, const Json &asset,
                     const std::vector<std::string> &urls,
                     const std::string &proxy, const std::atomic<bool> &cancel,
                     const DownloadProgress &progress,
                     const UpdateTransfer &transfer = {});
} // namespace javm::update
