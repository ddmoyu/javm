#include "file_platform.hpp"
#include <algorithm>
#include <cerrno>
#include <system_error>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstdio>
#endif

namespace media {
namespace {
[[noreturn]] void failed(const char* message) { throw std::runtime_error(message); }
#ifdef _WIN32
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE h): value(h) {}
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
};
#else
struct Handle {
    int value = -1;
    explicit Handle(int h): value(h) {}
    ~Handle() { if (value >= 0) ::close(value); }
    Handle(const Handle&) = delete;
};
void syncDirectory(const fs::path& path) {
    Handle directory(::open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (directory.value < 0 || ::fsync(directory.value) != 0)
        failed("文件已变更，但目录持久化失败，请保留恢复记录并检查磁盘");
}
bool regular(int fd) {
    struct stat info{};
    return fd >= 0 && ::fstat(fd, &info) == 0 && S_ISREG(info.st_mode);
}
#endif
}
const char* storageKind(const fs::path& path) noexcept {
#ifdef _WIN32
    try {
        std::wstring volume(32768, L'\0');
        if (!GetVolumePathNameW(path.c_str(), volume.data(), static_cast<DWORD>(volume.size()))) return "unknown";
        switch (GetDriveTypeW(volume.c_str())) {
        case DRIVE_FIXED: return "fixed";
        case DRIVE_REMOVABLE: return "removable";
        case DRIVE_REMOTE: return "remote";
        case DRIVE_CDROM: return "optical";
        case DRIVE_RAMDISK: return "ramdisk";
        default: return "unknown";
        }
    } catch (...) { return "unknown"; }
#else
    (void)path;
    return "unknown";
#endif
}
std::string fileIdentity(const fs::path& path) {
#ifdef _WIN32
    Handle handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (handle.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle.value, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)))
        failed("无法读取普通文件的身份");
    // 保留 Windows 已保存的恢复记录格式。
    return std::to_string(info.dwVolumeSerialNumber) + ":" + std::to_string(info.nFileIndexHigh) + ":" + std::to_string(info.nFileIndexLow);
#else
    struct stat info{};
    if (::lstat(path.c_str(), &info) != 0 || !S_ISREG(info.st_mode)) failed("无法读取普通文件的身份");
    return std::to_string(info.st_dev) + ":" + std::to_string(info.st_ino);
#endif
}
void createExclusiveFile(const fs::path& path, std::string_view content) {
    bool created = false;
    try {
#ifdef _WIN32
        Handle handle(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (handle.value == INVALID_HANDLE_VALUE) failed("无法创建独占文件，目标可能已存在");
        created = true;
        while (!content.empty()) {
            const auto count = static_cast<DWORD>(std::min<size_t>(content.size(), 1024 * 1024));
            DWORD written = 0;
            if (!WriteFile(handle.value, content.data(), count, &written, nullptr) || !written) failed("文件写入失败");
            content.remove_prefix(written);
        }
        if (!FlushFileBuffers(handle.value)) failed("文件持久化失败");
#else
        Handle handle(::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
        if (handle.value < 0) failed("无法创建独占文件，目标可能已存在");
        created = true;
        while (!content.empty()) {
            const auto count = ::write(handle.value, content.data(), std::min<size_t>(content.size(), 1024 * 1024));
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) failed("文件写入失败");
            content.remove_prefix(static_cast<size_t>(count));
        }
        if (::fsync(handle.value) != 0) failed("文件持久化失败");
        syncDirectory(path.parent_path());
#endif
    } catch (...) {
        if (created) { std::error_code error; fs::remove(path, error); }
        throw;
    }
}
void syncFile(const fs::path& path) {
#ifdef _WIN32
    Handle handle(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (handle.value == INVALID_HANDLE_VALUE || reparse(path) || !FlushFileBuffers(handle.value)) failed("文件持久化失败");
#else
    Handle handle(::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
    if (!regular(handle.value) || ::fsync(handle.value) != 0) failed("文件持久化失败");
#endif
}
void moveFile(const fs::path& from, const fs::path& to, bool replace) {
    // 必须位于同一文件系统；跨盘复制由既有分段复制与校验流程负责。
#ifdef _WIN32
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0)))
        failed("无法移动文件，目标可能已存在或被占用；文件与恢复记录已保留");
#else
    int result;
    if (replace) result = ::rename(from.c_str(), to.c_str());
#ifdef __APPLE__
    else result = ::renamex_np(from.c_str(), to.c_str(), RENAME_EXCL);
#else
    else result = ::renameat2(AT_FDCWD, from.c_str(), AT_FDCWD, to.c_str(), RENAME_NOREPLACE);
#endif
    if (result != 0) failed("无法原子移动文件，目标可能已存在或文件系统不支持；文件与恢复记录已保留");
    syncDirectory(to.parent_path());
    if (from.parent_path() != to.parent_path()) syncDirectory(from.parent_path());
#endif
}
void removeFile(const fs::path& path) {
#ifdef _WIN32
    if (!DeleteFileW(path.c_str())) failed("无法移除文件，请检查占用或权限后重试");
#else
    if (::unlink(path.c_str()) != 0) failed("无法移除文件，请检查占用或权限后重试");
    syncDirectory(path.parent_path());
#endif
}
void durableWrite(const fs::path& path, std::string_view content) {
    auto temporary = withSuffix(path, ".javm-" + uuid() + ".tmp");
    createExclusiveFile(temporary, content);
    try { moveFile(temporary, path, true); }
    catch (...) { std::error_code error; fs::remove(temporary, error); throw; }
}
struct MainInstanceLock::State {
#ifdef _WIN32
    Handle handle{INVALID_HANDLE_VALUE};
#else
    Handle handle{-1};
#endif
    bool primary = false;
};
MainInstanceLock::MainInstanceLock(const fs::path& database): state_(std::make_unique<State>()) {
#ifdef _WIN32
    uint64_t hash = 14695981039346656037ULL;
    for (const unsigned char c: pathKey(fs::absolute(database))) { hash ^= c; hash *= 1099511628211ULL; }
    const auto name = L"Local\\JAVM.Main." + std::to_wstring(hash);
    state_->handle.value = CreateMutexW(nullptr, FALSE, name.c_str());
    state_->primary = GetLastError() != ERROR_ALREADY_EXISTS;
    if (!state_->handle.value) { state_->handle.value = INVALID_HANDLE_VALUE; failed("无法创建主实例锁"); }
#else
    const auto path = withSuffix(database, ".main.lock");
    // 保留 inode：删除仍持有锁的文件会允许第二个实例锁住新 inode。
    state_->handle.value = ::open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
    struct stat info{};
    if (!regular(state_->handle.value) || ::fstat(state_->handle.value, &info) != 0 || info.st_uid != ::geteuid() || info.st_nlink != 1)
        failed("无法创建主实例锁");
    state_->primary = ::flock(state_->handle.value, LOCK_EX | LOCK_NB) == 0;
    if (!state_->primary && errno != EWOULDBLOCK && errno != EAGAIN) failed("无法读取主实例锁");
#endif
}
MainInstanceLock::~MainInstanceLock() = default;
bool MainInstanceLock::primary() const { return state_->primary; }
struct ArchiveFileLock::State {
#ifdef _WIN32
    Handle handle{INVALID_HANDLE_VALUE};
#else
    Handle handle{-1};
#endif
};
ArchiveFileLock::ArchiveFileLock(const fs::path& path): state_(std::make_unique<State>()) {
#ifdef _WIN32
    state_->handle.value = CreateFileW(path.c_str(), GENERIC_READ | DELETE, FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (state_->handle.value == INVALID_HANDLE_VALUE || reparse(path)) failed("损坏片库仍被其他程序占用，或路径已变化");
#else
    state_->handle.value = ::open(path.c_str(), O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    struct flock lock{};
    lock.l_type = F_WRLCK; lock.l_whence = SEEK_SET; // 整个文件包含 SQLite 的字节范围锁。
    if (!regular(state_->handle.value) || ::fcntl(state_->handle.value, F_SETLK, &lock) != 0)
        failed("损坏片库仍被其他程序占用，或当前目录不可写");
#endif
}
ArchiveFileLock::~ArchiveFileLock() = default;
}
