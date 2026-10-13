#include "extension_transport.hpp"
#if JAVM_USE_WINHTTP
#include "host_lifetime.hpp"
#else
#include "connection_lifetime.hpp"
#endif
#include "store.hpp"
#if JAVM_WITH_MEDIA
#include "scanner.hpp"
#include "work_queue.hpp"
#include "probe_service.hpp"
#endif
#include "http_service.hpp"
#include "service.hpp"
#include <atomic>
#include <iostream>
#include <memory>

template<class Char>
int runMain(int argc, Char* argv[]) {
    const auto command = argc > 1 ? fs::path(argv[1]) : fs::path();
#if JAVM_WITH_MEDIA
    if (argc == 3 && command == "--nfo-inspect") {
        try { std::cout << media::readNfo(fs::path(argv[2])).dump(); return 0; }
        catch (const std::exception& error) { std::cout << Json{{"error",error.what()}}.dump(); return 1; }
    }
    if (argc == 3 && command == "--media-probe") {
        try { std::cout << media::probeDirect(fs::path(argv[2])).dump(); return 0; }
        catch (const std::exception& error) { std::cout << Json{{"error", error.what()}}.dump(); return 1; }
    }
#endif
    if (argc == 2 && command == "--version") {
        std::cout << "JAVM " << JAVM_VERSION << " database extension, protocol 1\nSQLite " << sqlite3_libversion() << '\n';
        return 0;
    }
    if (argc != 3 || command != "--database") return 2;
    try {
        const auto bootstrap = javm::extension::readBootstrap(std::cin);
        auto socket = javm::extension::connect(bootstrap);
#if JAVM_USE_WINHTTP
        HostLifetime hostLifetime(bootstrap.port);
#else
        javm::extension::ConnectionLifetime hostLifetime([&] { return socket->connected(); });
#endif
        const auto databasePath = fs::absolute(fs::path(argv[2])).lexically_normal();

        std::unique_ptr<Database> database;
#if JAVM_WITH_MEDIA
        std::atomic<std::shared_ptr<media::LibraryService>> library;
#endif
        std::atomic_bool disconnected = false;
        auto sendResponse = [&](const Json& response) {
            if (disconnected) return false;
            if (socket->send(javm::extension::responseEnvelope(bootstrap, response))) return true;
            disconnected = true;
            return false;
        };
#if JAVM_WITH_MEDIA
        // 媒体库迁移、验证目录、分页和收藏在独立队列执行，接收线程继续处理下载和控制消息。
        media::WorkQueue libraryRequests(1, 64);
        media::ProbeService mediaProbes;
#endif
        javm::http::Service http;
        javm::platform::Service platform;
        // 主实例握手先于下载数据库独占锁；第二次启动可转发参数并退出。
        auto ensureDatabase=[&] {if(!database) database=std::make_unique<Database>(databasePath);};
        std::string message;
        while (socket->receive(message)) {
            const auto event = Json::parse(message, nullptr, false);
            message.clear();
            if (!event.is_object() || !event.contains("event") || event["event"] != "javm.database.request") continue;
            const auto data = event.value("data", Json::object());
            if (!data.is_object() || !data.contains("requestId") || !data["requestId"].is_string()) continue;
            const auto requestId = data["requestId"].get<std::string>();
            if (requestId.empty() || requestId.size() > 100) continue;
            Json response{{"requestId", requestId}};
            bool closing = false;
            try {
                if (data.value("protocol", 0) != 1) throw std::runtime_error("Database protocol mismatch");
                const auto method = data.at("method").get<std::string>();
                if (method == "capabilities") {
                    response["result"] = {{"protocol", 1}, {"database", true}, {"http", true}, {"media", JAVM_WITH_MEDIA != 0},
                        {"transport", JAVM_USE_WINHTTP ? "winhttp" : "curl"}};
                } else if (method.starts_with("platform.")) {
                    platform.request(requestId, method, data.value("params", Json::object()), sendResponse);
                    continue;
                } else if (method == "http.request") {
                    http.request(requestId, data.at("params"), sendResponse);
                    continue;
                } else if (method == "http.cancel") {
                    http.cancel(requestId, data.at("params").at("id").get<std::string>(), sendResponse);
                    continue;
#if JAVM_WITH_MEDIA
                } else if (method == "media.probe") {
                    mediaProbes.submit(requestId, data.at("params"), sendResponse);
                    continue;
                } else if (method == "media.cancelProbe") {
                    mediaProbes.cancel(data.at("params").at("id").get<std::string>());
                    response["result"] = Json::object();
                } else if (method.starts_with("library.")) {
                    if(!method.starts_with("library.instance.")) ensureDatabase();
                    const auto current = library.load();
                    if (current && (method == "library.status" || method == "library.cancel" || method == "library.legacy.status" || method == "library.legacy.cancel" || method == "library.scrape.cancel" || method == "library.backup.status" || method == "library.backup.cancel")) {
                        response["result"] = current->handle(method, data.value("params", Json::object()));
                    } else {
                        if (!libraryRequests.trySubmit([&,data,method,response]() mutable {
                            if (disconnected) return;
                            try {
                                auto service = library.load();
                                if (!service && method == "library.legacy.check") {
                                    response["result"] = media::legacy::inspect(databasePath.parent_path() / "library.sqlite3");
                                } else if (!service && method == "library.legacy.status") {
                                    response["result"] = {{"state","unchecked"}};
                                } else if (!service && method == "library.legacy.cancel") {
                                    response["result"] = Json::object();
                                } else {
                                    if (!service) {
                                        service = std::make_shared<media::LibraryService>(databasePath.parent_path() / "library.sqlite3");
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
#else
                } else if (method.starts_with("library.") || method.starts_with("media.")) {
                    throw std::runtime_error("当前核心构建尚未包含媒体服务");
#endif
                } else if (method == "close") {
                    response["result"] = database ? database->handle(method, Json::object()) : Json::object();
                } else {
                    ensureDatabase();
                    response["result"] = database->handle(method, data.value("params", Json::object()));
                }
                response["ok"] = true;
                closing = method == "close";
            } catch (const std::exception& error) { response["ok"] = false; response["error"] = error.what(); }
            if (!sendResponse(response)) break;
            if (closing) break;
        }
        disconnected = true;
        platform.shutdown();
        http.shutdown();
#if JAVM_WITH_MEDIA
        mediaProbes.shutdown();
        if (const auto service = library.load()) service->handle("library.cancel",Json::object());
        libraryRequests.close(true);
        libraryRequests.join();
        if (const auto service = library.load()) service->shutdown();
#endif
        socket->close();
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Database extension: " << error.what() << '\n';
        return 1;
    }
}
#ifdef _WIN32
int wmain(int argc, wchar_t* argv[]) { return runMain(argc, argv); }
#else
int main(int argc, char* argv[]) { return runMain(argc, argv); }
#endif
