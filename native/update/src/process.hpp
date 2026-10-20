#pragma once
#include "files.hpp"
#include <memory>
#include <vector>
namespace javm::update {
fs::path executablePath();
bool alive(uint64_t pid);
uint64_t processId();
std::string processIdentity(uint64_t pid);
bool sameProcess(uint64_t pid, const std::string &identity);
void stopProcessTree(uint64_t pid, const std::string &identity);
class TransactionLock {
  struct State;
  std::unique_ptr<State> state_;

public:
  explicit TransactionLock(const fs::path &file);
  ~TransactionLock();
};
std::string environment(const char *name);
class Child {
  struct State;
  std::unique_ptr<State> state_;

public:
  Child(const fs::path &executable, const std::vector<std::string> &arguments,
        bool detached = false, const std::string &transaction = "",
        bool show = false);
  ~Child();
  bool running();
  int wait(unsigned seconds);
  void stop();
  void release();
  uint64_t pid() const;
};
} // namespace javm::update
