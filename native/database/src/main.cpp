#include "host_lifetime.hpp"
#include "store.hpp"
#include "scanner.hpp"
#include "work_queue.hpp"
#include "probe_service.hpp"
#include <iostream>
#include <string_view>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#include <objbase.h>

struct InternetHandle {
    HINTERNET value;
    explicit InternetHandle(HINTERNET handle, const char* operation) : value(handle) {
        if (!value) throw std::runtime_error(std::string(operation) + " failed (Win32 " + std::to_string(GetLastError()) + ")");
    }
    ~InternetHandle() { WinHttpCloseHandle(value); }
    InternetHandle(const InternetHandle&) = delete;
    InternetHandle& operator=(const InternetHandle&) = delete;
};
std::wstring wide(const std::string& value) {
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (!count && !value.empty()) throw std::runtime_error("Invalid UTF-8");
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), count);
    return result;
}
std::string uuid() {
    GUID guid{};
    if (CoCreateGuid(&guid) != S_OK) throw std::runtime_error("Cannot create message id");
    wchar_t buffer[40]{};
    StringFromGUID2(guid, buffer, 40);
    std::string result;
    for (int i = 1; i < 37; ++i) result.push_back(static_cast<char>(buffer[i]));
    return result;
}
std::string queryValue(const std::string& value) {
    constexpr char hex[] = "0123456789ABCDEF";
    std::string result;
    for (const unsigned char ch : value) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '.' || ch == '_' || ch == '~') result += static_cast<char>(ch);
        else { result += '%'; result += hex[ch >> 4]; result += hex[ch & 15]; }
    }
    return result;
}

int wmain(int argc, wchar_t* argv[]) {
    if (argc == 3 && std::wstring_view(argv[1]) == L"--nfo-inspect") {
        try { std::cout << media::readNfo(fs::path(argv[2])).dump(); return 0; }
        catch (const std::exception& error) { std::cout << Json{{"error",error.what()}}.dump(); return 1; }
    }
    if (argc == 3 && std::wstring_view(argv[1]) == L"--media-probe") {
        try { std::cout << media::probeDirect(fs::path(argv[2])).dump(); return 0; }
        catch (const std::exception& error) { std::cout << Json{{"error", error.what()}}.dump(); return 1; }
    }
    if (argc == 2 && std::wstring_view(argv[1]) == L"--version") {
        std::cout << "JAVM " << JAVM_VERSION << " database extension, protocol 1\nSQLite " << sqlite3_libversion() << '\n';
        return 0;
    }
    if (argc != 3 || std::wstring_view(argv[1]) != L"--database") return 2;
    try {
        // Official Neutralino bootstrap only. All business requests use its WebSocket.
        const std::string input{std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>()};
        const auto bootstrap = Json::parse(input);
        const auto portText = bootstrap.at("nlPort");
        const int port = portText.is_string() ? std::stoi(portText.get<std::string>()) : portText.get<int>();
        if (port < 1 || port > 65535) return 2;
        const std::string token = bootstrap.at("nlToken");
        const auto target = wide("/?extensionId=" + queryValue(bootstrap.at("nlExtensionId")) + "&connectToken=" + queryValue(bootstrap.at("nlConnectToken")));
        InternetHandle session(WinHttpOpen(L"JAVM.Database/1", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0), "WinHttpOpen");
        InternetHandle connection(WinHttpConnect(session.value, L"127.0.0.1", static_cast<INTERNET_PORT>(port), 0), "WinHttpConnect");
        InternetHandle request(WinHttpOpenRequest(connection.value, L"GET", target.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0), "WinHttpOpenRequest");
        if (!WinHttpSetOption(request.value, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) ||
            !WinHttpSendRequest(request.value, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
            !WinHttpReceiveResponse(request.value, nullptr)) throw std::runtime_error("Neutralino connection failed");
        DWORD responseStatus = 0, responseStatusSize = sizeof(responseStatus);
        if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &responseStatus, &responseStatusSize, WINHTTP_NO_HEADER_INDEX) || responseStatus != 101)
            throw std::runtime_error("Neutralino WebSocket handshake failed (HTTP " + std::to_string(responseStatus) + ")");
        InternetHandle socket(WinHttpWebSocketCompleteUpgrade(request.value, 0), "WinHttpWebSocketCompleteUpgrade");
        HostLifetime hostLifetime(static_cast<unsigned short>(port));

        std::unique_ptr<Database> database;
        std::atomic<std::shared_ptr<media::LibraryService>> library;
        std::atomic_bool disconnected = false;
        std::mutex sendMutex;
        auto sendResponse = [&](const Json& response) {
            auto outgoing = Json{{"id", uuid()}, {"method", "app.broadcast"}, {"accessToken", token}, {"data", {{"event", "javm.database.response"}, {"data", response}}}}.dump();
            std::lock_guard lock(sendMutex);
            if (disconnected) return false;
            if (WinHttpWebSocketSend(socket.value, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, outgoing.data(), static_cast<DWORD>(outgoing.size())) == NO_ERROR) return true;
            disconnected = true;
            return false;
        };
        // 媒体库迁移、验证目录、分页和收藏在独立队列执行，接收线程继续处理下载和控制消息。
        media::WorkQueue libraryRequests(1, 64);
        media::ProbeService mediaProbes;
        std::string startupError;
        try { database = std::make_unique<Database>(fs::absolute(argv[2]).lexically_normal()); }
        catch (const std::exception& error) { startupError = error.what(); }
        std::string message;
        for (;;) {
            char buffer[16384];
            DWORD read = 0;
            WINHTTP_WEB_SOCKET_BUFFER_TYPE type{};
            if (WinHttpWebSocketReceive(socket.value, buffer, sizeof(buffer), &read, &type) != NO_ERROR || type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) break;
            message.append(buffer, read);
            if (message.size() > 4 * 1024 * 1024) throw std::runtime_error("Extension message too large");
            if (type != WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) continue;
            const auto event = Json::parse(message, nullptr, false);
            message.clear();
            if (event.is_discarded() || event.value("event", "") != "javm.database.request") continue;
            const auto data = event.value("data", Json::object());
            const auto requestId = data.value("requestId", "");
            if (requestId.empty()) continue;
            Json response{{"requestId", requestId}};
            bool closing = false;
            try {
                if (data.value("protocol", 0) != 1) throw std::runtime_error("Database protocol mismatch");
                const auto method = data.at("method").get<std::string>();
                if (method == "media.probe") {
                    mediaProbes.submit(requestId, data.at("params"), sendResponse);
                    continue;
                } else if (method == "media.cancelProbe") {
                    mediaProbes.cancel(data.at("params").at("id").get<std::string>());
                    response["result"] = Json::object();
                } else if (method.starts_with("library.")) {
                    if (!database) throw std::runtime_error(startupError);
                    const auto current = library.load();
                    if (current && (method == "library.status" || method == "library.cancel" || method == "library.legacy.status" || method == "library.legacy.cancel" || method == "library.scrape.cancel")) {
                        response["result"] = current->handle(method, data.value("params", Json::object()));
                    } else {
                        if (!libraryRequests.trySubmit([&,data,method,response]() mutable {
                            if (disconnected) return;
                            try {
                                auto service = library.load();
                                if (!service && method == "library.legacy.check") {
                                    response["result"] = media::legacy::inspect(fs::absolute(argv[2]).parent_path() / "library.sqlite3");
                                } else if (!service && method == "library.legacy.status") {
                                    response["result"] = {{"state","unchecked"}};
                                } else if (!service && method == "library.legacy.cancel") {
                                    response["result"] = Json::object();
                                } else {
                                    if (!service) {
                                        service = std::make_shared<media::LibraryService>(fs::absolute(argv[2]).parent_path() / "library.sqlite3");
                                        library.store(service);
                                    }
                                    if (disconnected) return;
                                    response["result"] = service->handle(method,data.value("params",Json::object()));
                                }
                                response["ok"] = true;
                            } catch (const std::exception& error) { response["ok"] = false; response["error"] = error.what(); }
                            sendResponse(response);
                        })) throw std::runtime_error("媒体库请求队列已满，请稍后重试");
                        continue;
                    }
                } else {
                    if (!database) throw std::runtime_error(startupError);
                    response["result"] = database->handle(method, data.value("params", Json::object()));
                }
                response["ok"] = true;
                closing = method == "close";
            } catch (const std::exception& error) { response["ok"] = false; response["error"] = error.what(); }
            if (!sendResponse(response)) break;
            if (closing) break;
        }
        disconnected = true;
        mediaProbes.shutdown();
        if (const auto service = library.load()) service->handle("library.cancel",Json::object());
        libraryRequests.close(true);
        libraryRequests.join();
        if (const auto service = library.load()) service->shutdown();
        WinHttpWebSocketClose(socket.value, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Database extension: " << error.what() << '\n';
        return 1;
    }
}
#else
int main() { std::cerr << "The database extension currently requires Windows.\n"; return 1; }
#endif
