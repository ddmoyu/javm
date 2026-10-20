#include "probe.hpp"
#include "../../native/common/cancellable_thread.hpp"
#include <iostream>
#include <thread>

template<class Char>
int run(int argc, Char* argv[]) {
    namespace probe = javm::probe;
    try {
        if (argc < 3) return 2;
        const auto mode = probe::fs::path(argv[1]);
        const auto file = probe::fs::path(argv[2]);
        const auto executable = probe::executablePath();
        if (mode == "--media-probe") {
            std::cout << probe::readDirect(file, executable.parent_path() / probe::libraryFilename()).dump();
            return 0;
        }
        if (mode != "--probe" || argc > 5) return 2;
        std::atomic_bool cancelled = false;
        const auto milliseconds = [&](int index, int fallback) {
            return argc > index ? std::stoi(probe::pathToUtf8(probe::fs::path(argv[index]))) : fallback;
        };
        const int timeout = milliseconds(3, 15000), cancelAfter = milliseconds(4, -1);
        if (cancelAfter == 0) cancelled = true;
        javm::CancellableThread timer([&](const std::atomic_bool& stop) {
            if (cancelAfter <= 0) return;
            const auto at = std::chrono::steady_clock::now() + std::chrono::milliseconds(cancelAfter);
            while (!stop && std::chrono::steady_clock::now() < at) std::this_thread::sleep_for(std::chrono::milliseconds(10));
            if (!stop) cancelled = true;
        });
        std::cout << probe::inspect(executable, file, cancelled, std::chrono::milliseconds(timeout)).dump();
        return 0;
    } catch (const std::exception& error) {
        std::cout << javm::probe::Json{{"error", error.what()}}.dump();
        return 1;
    }
}
#ifdef _WIN32
int wmain(int argc, wchar_t* argv[]) { return run(argc, argv); }
#else
int main(int argc, char* argv[]) { return run(argc, argv); }
#endif
