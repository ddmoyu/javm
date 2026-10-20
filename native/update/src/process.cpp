#include "process.hpp"
#include <chrono>
#include <fstream>
#include <sstream>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach-o/dyld.h>
#endif
#endif
namespace javm::update {
struct TransactionLock::State {
#ifdef _WIN32
  HANDLE handle{INVALID_HANDLE_VALUE};
  ~State() {
    if (handle != INVALID_HANDLE_VALUE)
      CloseHandle(handle);
  }
#else
  int descriptor{-1};
  ~State() {
    if (descriptor >= 0)
      ::close(descriptor);
  }
#endif
};
TransactionLock::TransactionLock(const fs::path &file)
    : state_(std::make_unique<State>()) {
#ifdef _WIN32
  state_->handle =
      CreateFileW(file.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                  OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (state_->handle == INVALID_HANDLE_VALUE)
    throw std::runtime_error("已有更新安装或恢复助手正在运行");
#else
  state_->descriptor = ::open(file.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  if (state_->descriptor < 0 || flock(state_->descriptor, LOCK_EX | LOCK_NB))
    throw std::runtime_error("已有更新安装或恢复助手正在运行");
#endif
}
TransactionLock::~TransactionLock() = default;
std::string processIdentity(uint64_t pid) {
  if (!pid)
    return {};
#ifdef _WIN32
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                               static_cast<DWORD>(pid));
  if (!process)
    return {};
  FILETIME created{}, exited{}, kernel{}, user{};
  const auto ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
  CloseHandle(process);
  return ok ? std::to_string((uint64_t(created.dwHighDateTime) << 32) |
                             created.dwLowDateTime)
            : "";
#elif defined(__APPLE__)
  proc_bsdinfo info{};
  if (proc_pidinfo(static_cast<int>(pid), PROC_PIDTBSDINFO, 0, &info,
                   sizeof(info)) != sizeof(info))
    return {};
  return std::to_string(info.pbi_start_tvsec) + "-" +
         std::to_string(info.pbi_start_tvusec);
#else
  std::ifstream file("/proc/" + std::to_string(pid) + "/stat");
  std::string line;
  std::getline(file, line);
  const auto end = line.rfind(')');
  if (end == std::string::npos)
    return {};
  std::istringstream fields(line.substr(end + 2));
  std::string value;
  for (int n = 3; n <= 22; ++n)
    if (!(fields >> value))
      return {};
  return value;
#endif
}
bool sameProcess(uint64_t pid, const std::string &identity) {
  return !identity.empty() && alive(pid) && processIdentity(pid) == identity;
}
void stopProcessTree(uint64_t pid, const std::string &identity) {
  if (!sameProcess(pid, identity))
    return;
#ifdef _WIN32
  HANDLE process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE,
                               static_cast<DWORD>(pid));
  if (!process)
    throw std::runtime_error("无法停止更新试运行");
  TerminateProcess(process, 1);
  WaitForSingleObject(process, 10000);
  CloseHandle(process);
#else
  kill(-static_cast<pid_t>(pid), SIGTERM);
  kill(static_cast<pid_t>(pid), SIGTERM);
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  kill(-static_cast<pid_t>(pid), SIGKILL);
  kill(static_cast<pid_t>(pid), SIGKILL);
#endif
  for (int i = 0; i < 100 && sameProcess(pid, identity); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  if (sameProcess(pid, identity))
    throw std::runtime_error("更新进程尚未退出，已停止恢复以保护数据");
}
uint64_t processId() {
#ifdef _WIN32
  return GetCurrentProcessId();
#else
  return static_cast<uint64_t>(getpid());
#endif
}
std::string environment(const char *name) {
#ifdef _WIN32
  const auto wide = fromUtf8(name).native();
  const DWORD size = GetEnvironmentVariableW(wide.c_str(), nullptr, 0);
  if (!size)
    return {};
  std::wstring value(size, L'\0');
  const auto count = GetEnvironmentVariableW(wide.c_str(), value.data(), size);
  value.resize(count);
  return utf8(fs::path(value));
#else
  const char *value = getenv(name);
  return value ? value : "";
#endif
}
fs::path executablePath() {
#ifdef _WIN32
  std::wstring value(32768, L'\0');
  const auto size = GetModuleFileNameW(nullptr, value.data(),
                                       static_cast<DWORD>(value.size()));
  if (!size || size >= value.size())
    throw std::runtime_error("无法定位更新组件");
  value.resize(size);
  return fs::path(value);
#elif defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string value(size, '\0');
  if (_NSGetExecutablePath(value.data(), &size))
    throw std::runtime_error("无法定位更新组件");
  return fs::canonical(value.c_str());
#else
  return fs::read_symlink("/proc/self/exe");
#endif
}
bool alive(uint64_t pid) {
  if (pid == 0)
    return false;
#ifdef _WIN32
  HANDLE handle = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
  if (!handle)
    return GetLastError() == ERROR_ACCESS_DENIED;
  const bool running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
  CloseHandle(handle);
  return running;
#else
  return kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM;
#endif
}
struct Child::State {
  uint64_t pid{};
  bool detached{};
  bool ended{};
  int code{-1};
#ifdef _WIN32
  HANDLE process{}, job{};
  ~State() {
    if (process)
      CloseHandle(process);
    if (job)
      CloseHandle(job);
  }
#endif
};
Child::Child(const fs::path &executable,
             const std::vector<std::string> &arguments, bool detached,
             const std::string &transaction, bool show)
    : state_(std::make_unique<State>()) {
  state_->detached = detached;
#ifdef _WIN32
  auto quote = [](const std::wstring &value) {
    std::wstring out = L"\"";
    size_t slashes = 0;
    for (wchar_t c : value) {
      if (c == L'\\') {
        ++slashes;
        continue;
      }
      out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
      slashes = 0;
      out += c;
    }
    out.append(slashes * 2, L'\\');
    return out + L'"';
  };
  std::wstring command = quote(executable.native());
  for (const auto &arg : arguments)
    command += L" " + quote(fromUtf8(arg).native());
  const auto previousTransaction = environment("JAVM_UPDATE_TRANSACTION");
  SetEnvironmentVariableW(L"JAVM_UPDATE_TRANSACTION",
                          transaction.empty() ? nullptr
                                              : fromUtf8(transaction).c_str());
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = show ? SW_SHOWNORMAL : SW_HIDE;
  PROCESS_INFORMATION process{};
  const DWORD flags = CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED |
                      (detached ? CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
                                : CREATE_NO_WINDOW);
  const BOOL created = CreateProcessW(
      executable.c_str(), command.data(), nullptr, nullptr, FALSE, flags,
      nullptr, executable.parent_path().c_str(), &startup, &process);
  SetEnvironmentVariableW(L"JAVM_UPDATE_TRANSACTION",
                          previousTransaction.empty()
                              ? nullptr
                              : fromUtf8(previousTransaction).c_str());
  if (!created)
    throw std::runtime_error("无法启动更新安装或恢复组件");
  state_->process = process.hProcess;
  state_->pid = process.dwProcessId;
  if (!detached) {
    state_->job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!state_->job ||
        !SetInformationJobObject(state_->job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(state_->job, process.hProcess)) {
      TerminateProcess(process.hProcess, 1);
      CloseHandle(process.hThread);
      throw std::runtime_error("无法监管更新子进程");
    }
  }
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);
#else
  (void)show;
  std::vector<std::string> storage{utf8(executable)};
  storage.insert(storage.end(), arguments.begin(), arguments.end());
  std::vector<char *> args;
  for (auto &arg : storage)
    args.push_back(arg.data());
  args.push_back(nullptr);
  const pid_t pid = fork();
  if (pid < 0)
    throw std::runtime_error("无法启动更新子进程");
  if (pid == 0) {
    setsid();
    if (!transaction.empty())
      setenv("JAVM_UPDATE_TRANSACTION", transaction.c_str(), 1);
    else
      unsetenv("JAVM_UPDATE_TRANSACTION");
    chdir(executable.parent_path().c_str());
    execv(executable.c_str(), args.data());
    _exit(127);
  }
  state_->pid = static_cast<uint64_t>(pid);
#endif
}
Child::~Child() = default;
uint64_t Child::pid() const { return state_->pid; }
bool Child::running() {
  if (state_->ended)
    return false;
#ifdef _WIN32
  if (WaitForSingleObject(state_->process, 0) == WAIT_TIMEOUT)
    return true;
  DWORD code = 1;
  GetExitCodeProcess(state_->process, &code);
  state_->code = static_cast<int>(code);
#else
  int status = 0;
  const auto result =
      waitpid(static_cast<pid_t>(state_->pid), &status, WNOHANG);
  if (result == 0)
    return true;
  state_->code = result < 0 ? 1 : WIFEXITED(status) ? WEXITSTATUS(status) : 1;
#endif
  state_->ended = true;
  return false;
}
int Child::wait(unsigned seconds) {
  const auto until =
      std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
  while (running()) {
    if (std::chrono::steady_clock::now() > until) {
      stop();
      throw std::runtime_error("更新子进程超时");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  return state_->code;
}
void Child::stop() {
#ifdef _WIN32
  if (state_->job)
    TerminateJobObject(state_->job, 1);
  else if (!state_->ended)
    TerminateProcess(state_->process, 1);
#else
  kill(-static_cast<pid_t>(state_->pid), SIGTERM);
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  kill(-static_cast<pid_t>(state_->pid), SIGKILL);
#endif
  const auto until =
      std::chrono::steady_clock::now() + std::chrono::seconds(10);
  auto active = [&] {
    const bool parent = running();
#ifdef _WIN32
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (state_->job) {
      if (!QueryInformationJobObject(state_->job,
                                     JobObjectBasicAccountingInformation,
                                     &accounting, sizeof(accounting), nullptr))
        throw std::runtime_error("无法确认更新进程树已停止");
      return parent || accounting.ActiveProcesses > 0;
    }
    return parent;
#else
    return parent || kill(-static_cast<pid_t>(state_->pid), 0) == 0;
#endif
  };
  while (active()) {
    if (std::chrono::steady_clock::now() > until)
      throw std::runtime_error("无法停止更新子进程");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}
void Child::release() {
#ifdef _WIN32
  if (state_->job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    if (!SetInformationJobObject(state_->job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits)))
      throw std::runtime_error("无法提交更新进程");
    CloseHandle(state_->job);
    state_->job = nullptr;
  }
#endif
  state_->detached = true;
}
} // namespace javm::update
