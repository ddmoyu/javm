#pragma once
#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <iphlpapi.h>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

// Neutralino's official bootstrap supplies the loopback port, but no process id.
// Keep a handle to that listener's owner: an inherited socket can outlive its host.
class HostLifetime {
    struct CloseProcess { void operator()(void* value) const { if (value) CloseHandle(value); } };
    std::unique_ptr<void, CloseProcess> host_;
    std::jthread watcher_;

    static HANDLE openHost(unsigned short port) {
        DWORD size = 0;
        GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
        for (int attempt = 0; attempt < 3 && size; ++attempt) {
            std::vector<unsigned char> buffer(size);
            const auto status = GetExtendedTcpTable(buffer.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
            if (status == ERROR_INSUFFICIENT_BUFFER) continue;
            if (status != NO_ERROR) break;
            const auto* table = reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(buffer.data());
            for (DWORD i = 0; i < table->dwNumEntries; ++i) {
                const auto& row = table->table[i];
                if (ntohs(static_cast<u_short>(row.dwLocalPort)) != port ||
                    (row.dwLocalAddr != htonl(INADDR_LOOPBACK) && row.dwLocalAddr != INADDR_ANY)) continue;
                HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, row.dwOwningPid);
                if (!process) break;
                FILETIME created{}, exited{}, kernel{}, user{}, ownCreated{};
                const bool valid = GetProcessTimes(process, &created, &exited, &kernel, &user) &&
                    GetProcessTimes(GetCurrentProcess(), &ownCreated, &exited, &kernel, &user) &&
                    CompareFileTime(&created, &ownCreated) <= 0 && WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
                if (valid) return process;
                CloseHandle(process);
                break;
            }
            break;
        }
        throw std::runtime_error("Cannot identify the Neutralino host process");
    }
public:
    explicit HostLifetime(unsigned short port): host_(openHost(port)), watcher_([this](std::stop_token stop) {
        while (!stop.stop_requested()) {
            const auto result = WaitForSingleObject(host_.get(), 250);
            if (result == WAIT_TIMEOUT) continue;
            if (result != WAIT_OBJECT_0) return;
            // Give ordinary IPC disconnection and database cleanup time to finish.
            for (int i = 0; i < 20 && !stop.stop_requested(); ++i) Sleep(100);
            if (!stop.stop_requested()) {
                // Abnormal host death only: never race a synchronous WinHTTP receive
                // with WinHttpCloseHandle. End this process, releasing its locks and
                // probe jobs. SQLite recovers its committed WAL on the next launch.
                TerminateProcess(GetCurrentProcess(), ERROR_PROCESS_ABORTED);
            }
            return;
        }
    }) {}
};
#endif
