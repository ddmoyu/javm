#pragma once
#include "common.hpp"
#include <memory>
#include <string_view>

namespace media {
// 这些操作只在原生后台线程调用；错误保留给任务的恢复流程处理。
std::string fileIdentity(const fs::path& path);
// 仅用于扫描诊断；无法判断时返回 unknown，不推断 SSD/HDD 或设备型号。
const char* storageKind(const fs::path& path) noexcept;
void createExclusiveFile(const fs::path& path, std::string_view content = {});
void syncFile(const fs::path& path);
void moveFile(const fs::path& from, const fs::path& to, bool replace = false);
void removeFile(const fs::path& path);
void durableWrite(const fs::path& path, std::string_view content);

class MainInstanceLock {
    struct State;
    std::unique_ptr<State> state_;
public:
    explicit MainInstanceLock(const fs::path& database);
    ~MainInstanceLock();
    MainInstanceLock(const MainInstanceLock&) = delete;
    bool primary() const;
};

// 损坏数据库归档阶段阻止其他 SQLite 连接进入，不代替 SQLite 事务锁。
class ArchiveFileLock {
    struct State;
    std::unique_ptr<State> state_;
public:
    explicit ArchiveFileLock(const fs::path& file);
    ~ArchiveFileLock();
    ArchiveFileLock(const ArchiveFileLock&) = delete;
};
std::string unicodeLower(const std::string& text);
int compareNatural(const std::string& left, const std::string& right);
}
