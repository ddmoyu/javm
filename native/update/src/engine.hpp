#pragma once
#include "files.hpp"
#include <atomic>
#include <mutex>
#include <thread>
namespace javm::update {
class Engine {
  fs::path dataRoot_, transaction_;
  Json context_, state_ = {{"phase", "idle"}};
  std::mutex mutex_;
  std::thread work_;
  std::atomic<bool> cancel_{false}, running_{false};
  bool downloadSession_ = false;
  void publish(const Json &patch);
  void download(Json request);

public:
  explicit Engine(fs::path dataRoot) : dataRoot_(std::move(dataRoot)) {}
  ~Engine();
  Json request(const std::string &method, const Json &params);
  void shutdown();
};
Json verifiedManifest(const Json &envelope);
void applyUpdate(const fs::path &transaction, bool recover);
void privilegedProgramStep(const fs::path &transaction, bool rollback);
} // namespace javm::update
