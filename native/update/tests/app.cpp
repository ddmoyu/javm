// 无界面、无网络，只在测试传入的临时目录使用虚构数据库。
#include "process.hpp"
#include <chrono>
#include <fstream>
#include <sqlite3.h>
#include <thread>
using namespace javm::update;
int main() {
  try {
    const auto transaction = environment("JAVM_UPDATE_TRANSACTION");
    if (transaction.empty()) {
      std::ofstream(executablePath().parent_path() / "old-launch.txt")
          << "safe fixture";
      return 0;
    }
    const auto root = fromUtf8(transaction);
    const auto job = readJson(root / "job.json");
    for (const char *name : {"library.sqlite3", "downloads-v1.sqlite3"}) {
      sqlite3 *database = nullptr;
      if (sqlite3_open(utf8(fromUtf8(job.at("dataRoot")) / name).c_str(),
                       &database) != SQLITE_OK)
        return 5;
      const auto result = sqlite3_exec(
          database,
          "UPDATE fixture SET value='new-safe-value'; PRAGMA user_version=2",
          nullptr, nullptr, nullptr);
      sqlite3_close(database);
      if (result != SQLITE_OK)
        return 6;
    }
    writeJson(fromUtf8(job.at("settings")) / "preferences.json",
              {{"value", "new-safe-value"}});
    const auto localMode = executablePath().parent_path() / "fixture-mode.json";
    const auto mode = fs::exists(localMode) ? localMode :
        executablePath().parent_path().parent_path() / "Resources/fixture-mode.json";
    if (readJson(mode).at("mode") == "fail")
      return 23;
    writeJson(root / "healthy.json",
              {{"version", job.at("version")},
               {"transaction", root.filename().string()}});
    for (int i = 0; i < 400; ++i) {
      if (fs::exists(root / "commit.json"))
        return 0;
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    return 24;
  } catch (...) {
    return 25;
  }
}
