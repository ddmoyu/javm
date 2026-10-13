#include "probe.hpp"
#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

extern char** environ;
namespace javm::probe {
namespace {
struct Pipe {
    int read = -1, write = -1;
    Pipe() {
        int values[2];
#ifdef __linux__
        if (pipe2(values, O_CLOEXEC)) throw std::runtime_error("无法创建媒体探测管道");
#else
        if (pipe(values)) throw std::runtime_error("无法创建媒体探测管道");
#endif
        read = values[0]; write = values[1];
        if (fcntl(read, F_SETFD, FD_CLOEXEC) || fcntl(write, F_SETFD, FD_CLOEXEC)) {
            closeRead(); closeWrite(); throw std::runtime_error("无法隔离媒体探测管道");
        }
    }
    void closeRead() { if (read >= 0) close(read); read = -1; }
    void closeWrite() { if (write >= 0) close(write); write = -1; }
    ~Pipe() { closeRead(); closeWrite(); }
    Pipe(const Pipe&) = delete;
    Pipe& operator=(const Pipe&) = delete;
};
class Payload {
    fs::path directory_;
public:
    fs::path file;
    Payload(const fs::path& worker, const fs::path& media, std::chrono::milliseconds timeout) {
        auto name = pathToUtf8(fs::temp_directory_path() / "javm-probe-XXXXXX");
        if (!mkdtemp(name.data())) throw std::runtime_error("无法创建探测参数目录");
        directory_ = fs::path(name);
        file = directory_ / "process.json";
        int fd = -1;
        try {
            fd = open(file.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
            if (fd < 0) throw std::runtime_error("无法创建探测参数文件");
            const auto content = Json{{"schema", 1}, {"file", pathToUtf8(worker)},
                {"args", {"--media-probe", pathToUtf8(media)}}, {"timeoutMs", timeout.count()}}.dump();
            std::size_t offset = 0;
            while (offset < content.size()) {
                const auto count = write(fd, content.data() + offset, content.size() - offset);
                if (count < 0 && errno == EINTR) continue;
                if (count <= 0) throw std::runtime_error("无法写入探测参数");
                offset += static_cast<std::size_t>(count);
            }
            close(fd);
        } catch (...) {
            if (fd >= 0) close(fd);
            clean();
            throw;
        }
    }
    void clean() noexcept {
        std::error_code error;
        fs::remove(file, error);
        fs::remove(directory_, error);
    }
    ~Payload() { clean(); }
};
struct SpawnOptions {
    posix_spawn_file_actions_t files{};
    posix_spawnattr_t attrs{};
    SpawnOptions() {
        if (posix_spawn_file_actions_init(&files)) throw std::runtime_error("无法初始化探测进程");
        if (posix_spawnattr_init(&attrs)) { posix_spawn_file_actions_destroy(&files); throw std::runtime_error("无法初始化探测进程"); }
    }
    ~SpawnOptions() { posix_spawn_file_actions_destroy(&files); posix_spawnattr_destroy(&attrs); }
};
struct Supervisor {
    Pipe& control;
    pid_t pid = -1;
    int reap() {
        int status = 0;
        pid_t result;
        do { result = waitpid(pid, &status, 0); } while (result < 0 && errno == EINTR);
        pid = -1;
        if (result < 0) throw std::runtime_error("无法确认媒体探测已退出");
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    }
    ~Supervisor() {
        // 监督器收到 EOF 后回收真正的工具组；不能直接杀掉监督器而留下工作进程。
        control.closeWrite();
        if (pid > 0) { try { reap(); } catch (...) {} }
    }
};
} // namespace
std::string capture(const fs::path& worker, const fs::path& file, const std::atomic_bool& cancelled, std::chrono::milliseconds timeout) {
    const auto supervisor = worker.parent_path() / "javm_process";
    if (access(supervisor.c_str(), X_OK)) throw std::runtime_error("POSIX 探测监督器缺失或不可执行");
    Payload payload(worker, file, timeout);
    Pipe control, output;
    if (fcntl(output.read, F_SETFL, O_NONBLOCK)) throw std::runtime_error("无法设置探测管道");
    SpawnOptions options;
    short flags = POSIX_SPAWN_SETPGROUP;
#ifdef __APPLE__
    flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
#endif
    if (posix_spawnattr_setflags(&options.attrs, flags) || posix_spawnattr_setpgroup(&options.attrs, 0) ||
        posix_spawn_file_actions_adddup2(&options.files, control.read, STDIN_FILENO) ||
        posix_spawn_file_actions_adddup2(&options.files, output.write, STDOUT_FILENO) ||
        posix_spawn_file_actions_addopen(&options.files, STDERR_FILENO, "/dev/null", O_WRONLY, 0))
        throw std::runtime_error("无法隔离探测标准流");
#ifdef __linux__
    if (posix_spawn_file_actions_addclosefrom_np(&options.files, 3)) throw std::runtime_error("无法隔离探测文件描述符");
#endif
    const auto executable = supervisor.native(), input = payload.file.native(), owner = std::to_string(getpid());
    const char* args[]{executable.c_str(), "--owner", owner.c_str(), "--payload", input.c_str(), nullptr};
    if (cancelled) throw std::runtime_error("媒体探测已取消");
    Supervisor child{control};
    if (posix_spawn(&child.pid, executable.c_str(), &options.files, &options.attrs, const_cast<char* const*>(args), environ)) {
        child.pid = -1;
        throw std::runtime_error("无法启动探测监督器");
    }
    control.closeRead(); output.closeWrite();
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    std::string text;
    for (;;) {
        if (cancelled) throw std::runtime_error("媒体探测已取消");
        if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("媒体探测超时");
        char buffer[4096];
        const auto count = read(output.read, buffer, sizeof(buffer));
        if (count > 0) {
            if (text.size() + static_cast<std::size_t>(count) > outputLimit) throw std::runtime_error("媒体探测输出过长");
            text.append(buffer, static_cast<std::size_t>(count));
            continue;
        }
        if (count < 0 && errno != EAGAIN && errno != EINTR) throw std::runtime_error("媒体探测读取失败");
        if (count == 0) {
            const auto code = child.reap();
            if (cancelled) throw std::runtime_error("媒体探测已取消");
            if (code == 124) throw std::runtime_error("媒体探测超时");
            if (code != 0) throw std::runtime_error("媒体探测进程异常退出");
            return text;
        }
        pollfd pending{output.read, POLLIN, 0};
        if (poll(&pending, 1, 25) < 0 && errno != EINTR) throw std::runtime_error("媒体探测管道异常");
    }
}
} // namespace javm::probe
