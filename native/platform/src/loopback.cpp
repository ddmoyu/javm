#include "service.hpp"
#include <stdexcept>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#endif

namespace javm::platform {
unsigned loopbackPort() {
#ifdef _WIN32
    struct Network {
        WSADATA data{};
        Network() { if (WSAStartup(MAKEWORD(2, 2), &data)) throw std::runtime_error("无法初始化本地网络"); }
        ~Network() { WSACleanup(); }
    } network;
    const auto fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd == INVALID_SOCKET) throw std::runtime_error("无法创建本地端口");
    struct Close { SOCKET fd; ~Close() { closesocket(fd); } } close{fd};
    int size = sizeof(sockaddr_in);
#else
    const auto fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) throw std::runtime_error("无法创建本地端口");
    struct Close { int fd; ~Close() { ::close(fd); } } close{fd};
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) == -1) throw std::runtime_error("无法保护本地端口句柄");
    socklen_t size = sizeof(sockaddr_in);
#endif
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) ||
        getsockname(fd, reinterpret_cast<sockaddr*>(&address), &size))
        throw std::runtime_error("无法分配本地端口");
    // 调用方立即启动服务并验证就绪；分配和服务 bind 之间仍可能被其他进程占用。
    return ntohs(address.sin_port);
}
}
