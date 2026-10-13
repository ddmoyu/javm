#include <filesystem>
#include <iostream>
#include <string>
#include <vector>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

int main(int argc, char* argv[]) {
    try {
        std::vector<char> buffer(65536);
#ifdef __APPLE__
        uint32_t size = static_cast<uint32_t>(buffer.size());
        if (_NSGetExecutablePath(buffer.data(), &size)) throw std::runtime_error("无法定位应用");
        const auto launcher = std::filesystem::canonical(buffer.data());
#else
        const auto size = readlink("/proc/self/exe", buffer.data(), buffer.size());
        if (size < 0 || static_cast<size_t>(size) == buffer.size()) throw std::runtime_error("无法定位应用");
        const auto launcher = std::filesystem::path(std::string(buffer.data(), static_cast<size_t>(size)));
#endif
        const auto directory = launcher.parent_path();
        const auto host = (directory / "JAVM-host").string();
        std::filesystem::current_path(directory);
        // execv 不经过 shell；安装路径与启动参数中的特殊字符保持为数据。
        std::vector<char*> args{const_cast<char*>(host.c_str())};
        for (int i = 1; i < argc; ++i) args.push_back(argv[i]);
        args.push_back(nullptr);
        execv(host.c_str(), args.data());
        throw std::runtime_error("无法启动 JAVM，请确认运行库已安装且程序有执行权限");
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
