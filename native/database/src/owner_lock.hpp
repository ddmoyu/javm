#pragma once
#include <filesystem>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

class DatabaseOwnerLock {
#ifdef _WIN32
    HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
    int handle_ = -1;
#endif
public:
    DatabaseOwnerLock() = default;
    DatabaseOwnerLock(const DatabaseOwnerLock&) = delete;
    DatabaseOwnerLock& operator=(const DatabaseOwnerLock&) = delete;
    ~DatabaseOwnerLock() {
#ifdef _WIN32
        if (handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
#else
        if (handle_ >= 0) ::close(handle_);
#endif
    }
    void acquire(const std::filesystem::path& database) {
        auto path = database;
        path += ".owner.lock";
#ifdef _WIN32
        handle_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
            OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
        const bool locked = handle_ != INVALID_HANDLE_VALUE;
#else
        // 不删除锁文件：删除后重建会产生两个 inode，使两个实例都获得独占锁。
        handle_ = ::open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
        struct stat info{};
        const bool locked = handle_ >= 0 && fstat(handle_, &info) == 0 && S_ISREG(info.st_mode) &&
            flock(handle_, LOCK_EX | LOCK_NB) == 0;
#endif
        if (!locked) throw std::runtime_error("下载数据库已被另一 JAVM 实例占用，或当前目录不可写。请使用已打开的窗口。");
    }
};
