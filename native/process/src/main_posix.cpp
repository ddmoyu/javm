#include "process_spec.hpp"
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

extern char** environ;
namespace {
using Clock = std::chrono::steady_clock;
volatile sig_atomic_t interrupted = 0;
void interrupt(int) { interrupted = 1; }
struct Fd {
    int value;
    explicit Fd(int fd) : value(fd) { if (fd < 0) throw std::runtime_error("Cannot open private payload"); }
    ~Fd() { close(value); }
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
};
javm::process::Spec readPayload(const std::string& path) {
    const auto slash = path.find_last_of('/');
    if (path.empty() || path.front() != '/' || slash == std::string::npos ||
        path.substr(slash + 1) != "process.json") throw std::runtime_error("Invalid payload path");
    Fd directory(open(path.substr(0, slash).c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    struct stat info{};
    if (fstat(directory.value, &info) || info.st_uid != geteuid() || (info.st_mode & 0777) != 0700)
        throw std::runtime_error("Payload directory is not private");
    Fd file(openat(directory.value, "process.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
    if (fstat(file.value, &info) || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
        (info.st_mode & 077) != 0 || info.st_nlink != 1 || info.st_size < 0 ||
        static_cast<std::uintmax_t>(info.st_size) > javm::process::maxPayloadBytes)
        throw std::runtime_error("Payload file is not private");
    if (unlinkat(directory.value, "process.json", 0)) throw std::runtime_error("Cannot consume payload");
    std::string content;
    char buffer[4096];
    for (;;) {
        const auto count = read(file.value, buffer, sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) throw std::runtime_error("Cannot read payload");
        if (count == 0) break;
        content.append(buffer, static_cast<std::size_t>(count));
        if (content.size() > javm::process::maxPayloadBytes) throw std::runtime_error("Payload too large");
    }
    return javm::process::parseSpec(content);
}
void closeInheritedDescriptors() {
#ifdef __linux__
    DIR* directory = opendir("/proc/self/fd");
#else
    DIR* directory = opendir("/dev/fd");
#endif
    if (directory) {
        const int own = dirfd(directory);
        while (const auto* entry = readdir(directory)) {
            int fd = -1;
            const std::string_view name(entry->d_name);
            const auto result = std::from_chars(name.data(), name.data() + name.size(), fd);
            if (result.ec == std::errc{} && result.ptr == name.data() + name.size() && fd > 2 && fd != own) close(fd);
        }
        closedir(directory);
    } else {
        const long limit = sysconf(_SC_OPEN_MAX);
        if (limit < 0 || limit > 1'048'576) throw std::runtime_error("Cannot isolate file descriptors");
        for (int fd = 3; fd < limit; ++fd) close(fd);
    }
}
bool cancelled(pid_t owner, int delay) {
    // exec 去掉外层 shell，父进程必须一直是启动本监督器的 Neutralino 宿主。
    // 不根据 kill(pid, 0) 猜测身份，宿主退出后即使 PID 被复用也能识别。
    if (interrupted || getppid() != owner) return true;
    pollfd input{STDIN_FILENO, POLLIN, 0};
    const auto ready = poll(&input, 1, delay);
    if (ready < 0) return errno != EINTR || interrupted;
    // stdin 只用于关闭通知，不接受业务请求；任何输入也按停止处理。
    return interrupted || getppid() != owner || (ready > 0 && input.revents != 0);
}
struct Child {
    pid_t pid = -1;
    void signal(int value) const noexcept {
        // leader 尚未 waitpid 回收，其 PID/PGID 无法被其他新进程复用。
        if (pid > 1) { kill(-pid, value); kill(pid, value); }
    }
    int reap() noexcept {
        int status = 0;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
#ifdef __linux__
        // subreaper 接管留在同一组的孙进程；不等待或发信号给其他进程组。
        while (waitpid(-pid, nullptr, 0) > 0 || errno == EINTR) {}
#endif
        pid = -1;
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    }
    ~Child() { if (pid > 1) { signal(SIGKILL); reap(); } }
};
struct SpawnOptions {
    posix_spawn_file_actions_t files{};
    posix_spawnattr_t attrs{};
    SpawnOptions() {
        if (posix_spawn_file_actions_init(&files)) throw std::runtime_error("Cannot initialize process");
        if (posix_spawnattr_init(&attrs)) {
            posix_spawn_file_actions_destroy(&files);
            throw std::runtime_error("Cannot initialize process");
        }
    }
    ~SpawnOptions() { posix_spawn_file_actions_destroy(&files); posix_spawnattr_destroy(&attrs); }
};
int supervise(const javm::process::Spec& spec, pid_t owner) {
    std::map<std::string, std::string> environment;
    for (char** item = environ; *item; ++item) {
        const std::string value(*item);
        const auto equal = value.find('=');
        if (equal != std::string::npos) environment[value.substr(0, equal)] = value.substr(equal + 1);
    }
    for (const auto& [key, value] : spec.envs) environment[key] = value;
    std::vector<std::string> values;
    for (const auto& [key, value] : environment) values.push_back(key + '=' + value);
    std::vector<char*> envs;
    for (auto& value : values) envs.push_back(value.data());
    envs.push_back(nullptr);
    std::vector<char*> args{const_cast<char*>(spec.file.c_str())};
    for (const auto& arg : spec.args) args.push_back(const_cast<char*>(arg.c_str()));
    args.push_back(nullptr);
    SpawnOptions options;
    sigset_t empty, defaults;
    sigemptyset(&empty);
    sigemptyset(&defaults);
    for (const int sig : {SIGINT, SIGTERM, SIGHUP, SIGPIPE, SIGCHLD}) sigaddset(&defaults, sig);
    if (posix_spawnattr_setsigmask(&options.attrs, &empty) ||
        posix_spawnattr_setsigdefault(&options.attrs, &defaults) ||
        posix_spawnattr_setpgroup(&options.attrs, 0) ||
        posix_spawnattr_setflags(&options.attrs, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF) ||
        posix_spawn_file_actions_addopen(&options.files, STDIN_FILENO, "/dev/null", O_RDONLY, 0) ||
        posix_spawn_file_actions_adddup2(&options.files, STDOUT_FILENO, STDOUT_FILENO) ||
        posix_spawn_file_actions_adddup2(&options.files, STDERR_FILENO, STDERR_FILENO))
        throw std::runtime_error("Cannot configure process");
    if (cancelled(owner, 0)) return 130;
    Child child;
    const int error = posix_spawn(&child.pid, spec.file.c_str(), &options.files, &options.attrs, args.data(), envs.data());
    if (error) { child.pid = -1; throw std::runtime_error("Cannot start tool"); }
    const auto start = Clock::now();
    bool stopping = false;
    int exitCode = 130;
    Clock::time_point killAt{};
    for (;;) {
        siginfo_t info{};
        // WNOWAIT 保留 leader 的身份，先回收剩余进程组，再释放 PID。
        if (waitid(P_PID, static_cast<id_t>(child.pid), &info, WEXITED | WNOHANG | WNOWAIT) < 0 && errno != EINTR)
            throw std::runtime_error("Cannot observe tool");
        if (!stopping && info.si_pid == child.pid) {
            child.signal(SIGKILL);
            return child.reap();
        }
        const bool stop = cancelled(owner, 50);
        const bool timedOut = spec.timeoutMs > 0 && Clock::now() - start >= std::chrono::milliseconds(spec.timeoutMs);
        if (!stopping && (stop || timedOut)) {
            stopping = true;
            exitCode = timedOut && !stop ? 124 : 130;
            child.signal(SIGTERM);
            killAt = Clock::now() + std::chrono::seconds(1);
        }
        if (stopping && Clock::now() >= killAt) {
            child.signal(SIGKILL);
            // 内核不可中断 I/O 时继续等待，不能假报已停止并允许删除仍占用的文件。
            child.reap();
            return exitCode;
        }
        // 关闭的管道始终可读；停止期间仍让出 CPU。
        if (stopping) poll(nullptr, 0, 50);
    }
}
} // namespace
int main(int argc, char** argv) {
    try {
        if (argc != 5 || std::string_view(argv[1]) != "--owner" || std::string_view(argv[3]) != "--payload")
            throw std::runtime_error("Invalid supervisor command");
        pid_t owner = 0;
        const std::string_view ownerText(argv[2]);
        const auto parsed = std::from_chars(ownerText.data(), ownerText.data() + ownerText.size(), owner);
        if (parsed.ec != std::errc{} || parsed.ptr != ownerText.data() + ownerText.size() || owner <= 1 || getppid() != owner)
            throw std::runtime_error("Supervisor owner mismatch");
        struct sigaction action{};
        sigemptyset(&action.sa_mask);
        action.sa_handler = interrupt;
        for (const int sig : {SIGINT, SIGTERM, SIGHUP}) if (sigaction(sig, &action, nullptr)) throw std::runtime_error("Cannot watch signals");
        action.sa_handler = SIG_IGN;
        if (sigaction(SIGPIPE, &action, nullptr)) throw std::runtime_error("Cannot configure signals");
        action.sa_handler = SIG_DFL;
        if (sigaction(SIGCHLD, &action, nullptr)) throw std::runtime_error("Cannot observe children");
        sigset_t empty;
        sigemptyset(&empty);
        if (sigprocmask(SIG_SETMASK, &empty, nullptr)) throw std::runtime_error("Cannot configure signal mask");
#ifdef __linux__
        if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) throw std::runtime_error("Cannot supervise descendants");
#endif
        const auto spec = readPayload(argv[4]);
        closeInheritedDescriptors();
        return supervise(spec, owner);
    } catch (const std::exception&) {
        // 不输出路径、参数、环境或解析上下文，避免泄露令牌。
        std::fputs("JAVM process supervisor: startup or lifecycle failure\n", stderr);
        return 125;
    }
}
